/**
 * Pipeline Orchestrator — execution engine
 *
 * Spawns pi subprocesses for each phase execution.
 * Uses the same mechanism as pi's subagent extension:
 *   pi --mode json -p --no-session --append-system-prompt <agent-file> "Task: ..."
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "./agents.js";
import type { PhaseDefinition } from "./types.js";

export interface PhaseResult {
	entityId: string;
	phase: string;
	exitCode: number;
	output: string;
	stderr: string;
	error?: string;
	/** Path to trace file (streamed to disk, not in memory) */
	tracePath?: string;
}

/**
 * Run a single phase for an entity.
 *
 * Spawns: pi --mode json -p --no-session
 *   --append-system-prompt <tmp-agent-file>
 *   [--model <model>]
 *   [--tools <tools>]
 *   "Task: <prompt>"
 *
 * Returns the final assistant text output.
 */
export async function executePhase(
	entityId: string,
	phase: PhaseDefinition,
	agent: AgentConfig,
	taskPrompt: string,
	cwd: string,
	onActivity?: (msg: string) => void,
	signal?: AbortSignal,
	logPath?: string,
	retry?: number,
	/** Variables for hook substitution (e.g. { entity, repo_dir, work_dir }) */
	hookVars?: Record<string, string>,
): Promise<PhaseResult> {
	const result: PhaseResult = {
		entityId,
		phase: phase.name,
		exitCode: 0,
		output: "",
		stderr: "",
	};

	// Default 30-minute timeout per phase (prevent indefinite hang)
	const timeoutMs = (phase.timeoutMinutes ?? 30) * 60 * 1000;
	const phaseSignal = signal ?? AbortSignal.timeout(timeoutMs);

	// Write agent system prompt to temp file
	const tmpDir = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), "pi-pipeline-"),
	);
	const tmpPromptPath = path.join(tmpDir, `agent-${agent.name}.md`);
	await fs.promises.writeFile(tmpPromptPath, agent.systemPrompt, "utf-8");

	// ── PhaseHooks: before ──
	if (phase.hooks?.before) {
		let hookCmd = phase.hooks.before;
		// Variable substitution: {entity} + any hookVars
		hookCmd = hookCmd.replace(/\{entity\}/g, entityId);
		if (hookVars) {
			for (const [k, v] of Object.entries(hookVars)) {
				hookCmd = hookCmd.replace(new RegExp(`\\{${k}\\}`, "g"), v);
			}
		}
		try {
			const r = spawnSync("bash", ["-c", hookCmd], { cwd, timeout: 30000 });
			if (r.status !== 0) {
				result.error = `hooks.before failed (exit ${r.status}): ${r.stderr?.toString().slice(0, 200)}`;
				result.exitCode = 1;
				return result;
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			result.error = `hooks.before error: ${msg}`;
			result.exitCode = 1;
			return result;
		}
	}

	// Stream trace events to temp file (avoids OOM from accumulating in memory)
	const tracePath = path.join(tmpDir, "trace.jsonl");
	const traceStream = fs.createWriteStream(tracePath, { flags: "a" });
	result.tracePath = tracePath;

	// Stream human-readable log if path provided
	let logStream: fs.WriteStream | null = null;
	if (logPath) {
		try {
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			logStream = fs.createWriteStream(logPath, { flags: "a" });
			if (retry && retry > 0) {
				logStream.write(`\n\n--- Retry ${retry} ---\n\n`);
			} else {
				logStream.write(`# Agent: ${agent.name}\n# Phase: ${phase.name}\n# Entity: ${entityId}\n# Time: ${new Date().toISOString()}\n\n`);
			}
		} catch {
			/* non-critical */
		}
	}

	try {
		const args: string[] = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--append-system-prompt",
			tmpPromptPath,
		];

		const model = phase.model || agent.model;
		if (model) args.push("--model", model);
		if (phase.tools || agent.tools?.length) {
			const tools = phase.tools || agent.tools?.join(",") || "";
			if (tools) args.push("--tools", tools);
		}

		args.push(taskPrompt);

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";
			let lastAssistantText = "";

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.trim()) continue;
					traceStream.write(`${line}
`);
					try {
						const event = JSON.parse(line);
					// ── Stream to human-readable log (pi JSON event format) ──
					if (logStream) {
						const inner = event.assistantMessageEvent || event;
						const etype = inner.type || event.type;
						if (etype === "toolcall_start" || event.type === "tool_use") {
							const t = inner.toolName || event.toolName || "?";
							const inp = inner.toolInput || event.toolInput || {};
							const fp = inp.filePath || inp.path || "";
							const nm = fp ? fp.split("/").pop() : "";
							logStream.write(`\n📎 [${t}] ${nm || fp || ""}\n`);
						} else if (etype === "text_delta" || etype === "thinking_delta") {
							// Use inner.delta (incremental), NOT partial.content[].text (cumulative)
							const delta = inner.delta;
							if (typeof delta === "string" && delta) logStream.write(delta);
						} else if (event.type === "message_delta" && event.delta?.text) {
							logStream.write(event.delta.text);
						} else if (event.type === "content_block_delta" && event.delta?.text) {
							logStream.write(event.delta.text);
						} else if (event.type === "stream_event" && event.text) {
							logStream.write(event.text);
						}
					}
						// Real-time activity + assistant text tracking (pi message_update format)
						const inner = event.assistantMessageEvent || event;
						const etype = event.assistantMessageEvent ? inner.type : event.type;
						if (onActivity) {
							if (etype === "thinking_start") {
								onActivity("💭 思考中...");
							} else if (etype === "toolcall_start" || event.type === "tool_use") {
								const tool = inner.toolName || event.toolName || "?";
								const inp = inner.toolInput || event.toolInput || {};
								const fp = inp.filePath || inp.path || "";
								const name = fp ? fp.split("/").pop() : "";
								if (tool === "read" && name) onActivity(`🔍 读取 ${name}`);
								else if (tool === "write" && name) onActivity(`✏️ 写入 ${name}`);
								else if (tool === "edit" && name) onActivity(`🔧 编辑 ${name}`);
								else onActivity(`🔧 ${tool}`);
							}
						}
						// Capture assistant text from message_end (or message_update text_end)
						if (etype === "text_end" || event.type === "message_end") {
							const msg = event.message || inner.partial;
							if (msg?.role === "assistant" || msg?.role === undefined) {
								if (msg.stopReason === "error" && msg.errorMessage) {
									result.error = msg.errorMessage;
								}
								const text = msg.content
									?.filter((p: { type: string }) => p.type === "text" || p.type === "output_text")
									.map((p: { text: string }) => p.text)
									.join("\n");
								if (text) lastAssistantText = text;
							}
						}
					} catch {
						// skip malformed JSON lines
					}
				}
			});

			proc.stderr.on("data", (data: Buffer) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					traceStream.write(`${buffer.trim()}
`);
					try {
						const event = JSON.parse(buffer.trim());
						const inner = event.assistantMessageEvent || event;
						const etype = event.assistantMessageEvent ? inner.type : event.type;
						if (etype === "text_end" || event.type === "message_end") {
							const msg = event.message || inner.partial;
							if (msg?.role === "assistant" || msg?.role === undefined) {
								if (msg.stopReason === "error" && msg.errorMessage) {
									result.error = msg.errorMessage;
								}
								const text = msg.content
									?.filter((p: { type: string }) => p.type === "text" || p.type === "output_text")
									.map((p: { text: string }) => p.text)
									.join("\n");
								if (text) lastAssistantText = text;
							}
						}
					} catch {
						// skip
					}
				}
				result.output = lastAssistantText;
				traceStream.end();
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (phaseSignal) {
				const onAbort = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (phaseSignal.aborted) {
					result.error = "Phase timed out (30 min)";
					onAbort();
				} else phaseSignal.addEventListener("abort", onAbort, { once: true });
			}
		});

	// ── PhaseHooks: after ──
	if (result.exitCode === 0 && phase.hooks?.after) {
		let hookCmd = phase.hooks.after;
		hookCmd = hookCmd.replace(/\{entity\}/g, entityId);
		if (hookVars) {
			for (const [k, v] of Object.entries(hookVars)) {
				hookCmd = hookCmd.replace(new RegExp(`\\{${k}\\}`, "g"), v);
			}
		}
		try {
			const r = spawnSync("bash", ["-c", hookCmd], { cwd, timeout: 30000 });
			if (r.status !== 0) {
				result.exitCode = 1;
				result.error = `hooks.after failed (exit ${r.status}): ${r.stderr?.toString().slice(0, 200)}`;
			}
		} catch (err: unknown) {
			result.exitCode = 1;
			const msg = err instanceof Error ? err.message : String(err);
			result.error = `hooks.after error: ${msg}`;
		}
	}

		result.exitCode = exitCode;
		if (exitCode !== 0 && !result.output) {
			result.error = result.stderr || `Exit code ${exitCode}`;
		}
		return result;
	} finally {
		try {
			traceStream.end();
		} catch {
			/* ok */
		}
		try {
			if (logStream) logStream.end();
		} catch {
			/* ok */
		}
		try {
			fs.unlinkSync(tmpPromptPath);
		} catch {
			/* ok */
		}
		// Note: tmpDir (with trace.jsonl) is NOT deleted here.
		// index.ts copies trace to outputDir, then cleans up.
	}
}

/**
 * Run a bash validation command.
 * Returns true if validation passes (exit code 0).
 */
export async function runValidation(
	command: string,
	cwd: string,
): Promise<{ passed: boolean; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn("bash", ["-c", command], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

		proc.on("close", (code) => {
			resolve({ passed: code === 0, stdout, stderr });
		});
		proc.on("error", () => resolve({ passed: false, stdout, stderr }));
	});
}
