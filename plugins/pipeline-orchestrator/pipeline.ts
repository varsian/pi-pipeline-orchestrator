/**
 * Pipeline Orchestrator — execution engine v5 (omp)
 *
 * Uses omp's createAgentSession SDK (in-process) instead of spawning
 * pi subprocesses. This eliminates JSON stream parsing fragility and
 * gives direct access to structured agent output.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createAgentSession,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import type { PhaseDefinition } from "./types.js";

export interface PhaseResult {
	entityId: string;
	phase: string;
	exitCode: number;
	output: string;
	stderr: string;
	error?: string;
}

/** Parse comma-separated tool names string into array, filtering empties. */
function parseToolNames(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
}

/**
 * Run a single phase for an entity using an in-memory omp agent session.
 *
 * The agent's system prompt is prepended to the task as context.
 * Agent output is collected from the final assistant message.
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
	hookVars?: Record<string, string>,
	logger?: { info: (msg: string, data?: unknown) => void; warn: (msg: string, data?: unknown) => void; error: (msg: string, data?: unknown) => void },
): Promise<PhaseResult> {
	const result: PhaseResult = {
		entityId,
		phase: phase.name,
		exitCode: 0,
		output: "",
		stderr: "",
	};

	const timeoutMs = (phase.timeoutMinutes ?? 30) * 60 * 1000;

	// ── PhaseHooks: before ──
	if (phase.hooks?.before) {
		const hookResult = runHook(
			phase.hooks.before,
			entityId,
			hookVars,
			cwd,
			"before",
		);
		if (hookResult) {
			result.error = hookResult;
			result.exitCode = 1;
			return result;
		}
	}

	// ── Open log file if path provided ──
	let logStream: fs.WriteStream | null = null;
	if (logPath) {
		try {
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			logStream = fs.createWriteStream(logPath, { flags: "a" });
			if (retry && retry > 0) {
				logStream.write(`\n\n--- Retry ${retry} ---\n\n`);
			} else {
				logStream.write(
					`# Agent: ${agent.name}\n# Phase: ${phase.name}\n# Entity: ${entityId}\n# Time: ${new Date().toISOString()}\n\n`,
				);
			}
		} catch {
			/* non-critical */
		}
	}

	const model = phase.model || agent.model;
	const toolNames = parseToolNames(
		phase.tools ?? agent.tools?.join(","),
	);

	// Prepend agent system prompt to task as context
	const combinedPrompt = `<agent-instructions>\n${agent.systemPrompt}\n</agent-instructions>\n\n${taskPrompt}`;

	try {
		const { session } = await createAgentSession({
			sessionManager: SessionManager.inMemory(),
			model,
			toolNames: toolNames.length > 0 ? toolNames : undefined,
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
		});

		let lastText = "";

		const unsubscribe = session.subscribe(
			(event: unknown) => {
				const e = event as Record<string, unknown>;
				const type = typeof e.type === "string" ? e.type : "";

				// Activity notifications
				if (onActivity) {
					if (type === "tool_execution_start") {
						const toolName =
							typeof e.toolName === "string" ? e.toolName : "?";
						onActivity(`🔧 ${toolName}`);
					} else if (type === "thinking_start") {
						onActivity("💭 thinking…");
					}
				}

				// Log writing
				if (logStream) {
					if (type === "tool_execution_start") {
						const toolName =
							typeof e.toolName === "string" ? e.toolName : "?";
						logStream.write(`\n📎 [${toolName}]\n`);
					}
				}

				// Capture final assistant text from message_update.text_end
				if (type === "message_update") {
					const inner = e.assistantMessageEvent as
						| Record<string, unknown>
						| undefined;
					if (inner?.type === "text_end") {
						const partial = inner.partial as
							| Record<string, unknown>
							| undefined;
						const content = partial?.content as
							| Array<Record<string, unknown>>
							| undefined;
						if (content) {
							lastText = content
								.filter(
									(c) =>
										c.type === "text" ||
										c.type === "output_text",
								)
								.map((c) =>
									typeof c.text === "string"
										? c.text
										: "",
								)
								.join("\n");
						}
					} else if (
						inner?.type === "text_delta" &&
						typeof inner.delta === "string" &&
						logStream
					) {
						logStream.write(inner.delta);
					}
				}
			},
		);

		try {
			const promptPromise = session.prompt(combinedPrompt);

			if (signal) {
				const { promise: abortPromise, reject: abortReject } =
					Promise.withResolvers<never>();
				const onAbort = () =>
					abortReject(new Error("Phase aborted"));
				if (signal.aborted) {
					onAbort();
				} else {
					signal.addEventListener("abort", onAbort, {
						once: true,
					});
				}
				await Promise.race([promptPromise, abortPromise]);
			} else {
				const { promise: timeoutPromise, reject: timeoutReject } =
					Promise.withResolvers<never>();
				const timer = setTimeout(
					() => timeoutReject(new Error("Phase timed out")),
					timeoutMs,
				);
				try {
					await Promise.race([promptPromise, timeoutPromise]);
				} finally {
					clearTimeout(timer);
				}
			}
		} catch (err: unknown) {
			const msg =
				err instanceof Error ? err.message : String(err);
			if (
				msg === "Phase aborted" ||
				msg === "Phase timed out"
			) {
				result.error = msg;
				result.exitCode = 1;
			} else {
				result.error = `Agent error: ${msg}`;
				result.exitCode = 1;
			}
		}

		unsubscribe();

		// Extract final output from the session's branch
		const branch = session.sessionManager.getBranch();
		const lastAssistant = branch
			.filter(
				(e: Record<string, unknown>) =>
					e.type === "message" &&
					Boolean(e.message),
			)
			.pop() as Record<string, unknown> | undefined;

		if (lastAssistant && !result.output) {
			const msg = lastAssistant.message as Record<string, unknown>;
			const content = msg?.content as
				| Array<Record<string, unknown>>
				| undefined;
			if (content) {
				result.output = content
					.filter(
						(c) =>
							c.type === "text" ||
							c.type === "output_text",
					)
					.map((c) =>
						typeof c.text === "string" ? c.text : "",
					)
					.join("\n");
			}
		}

		// Fallback to text captured from events
		if (!result.output && lastText) {
			result.output = lastText;
		}

		try { await session.dispose(); } catch { /* non-critical */ }
	} catch (err: unknown) {
		result.error = `Session error: ${err instanceof Error ? err.message : String(err)}`;
		result.exitCode = 1;
		return result;
	} finally {
		try {
			if (logStream) logStream.end();
		} catch {
			/* ok */
		}
	}

	// ── PhaseHooks: after ──
	if (result.exitCode === 0 && phase.hooks?.after) {
		const hookResult = runHook(
			phase.hooks.after,
			entityId,
			hookVars,
			cwd,
			"after",
		);
		if (hookResult) {
			result.exitCode = 1;
			result.error = hookResult;
		}
	}

	return result;
}

/** Run a hook bash command with variable substitution. Returns error string or null. */
function runHook(
	command: string,
	entityId: string,
	hookVars: Record<string, string> | undefined,
	cwd: string,
	stage: "before" | "after",
): string | null {
	let cmd = command;
	cmd = cmd.replace(/\{entity\}/g, entityId);
	if (hookVars) {
		for (const [k, v] of Object.entries(hookVars)) {
			cmd = cmd.replace(new RegExp(`\\{${k}\\}`, "g"), v);
		}
	}
	try {
		const r = spawnSync("bash", ["-c", cmd], { cwd, timeout: 30000 });
		if (r.status !== 0) {
			return `hooks.${stage} failed (exit ${r.status}): ${String(r.stderr).slice(0, 200)}`;
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return `hooks.${stage} error: ${msg}`;
	}
	return null;
}

/**
 * Run a bash validation command.
 * Returns true if validation passes (exit code 0).
 */
export async function runValidation(
	command: string,
	cwd: string,
): Promise<{ passed: boolean; stdout: string; stderr: string }> {
	const proc = spawnSync("bash", ["-c", command], {
		cwd,
		timeout: 30000,
		encoding: "utf-8",
	});
	return {
		passed: proc.status === 0,
		stdout: proc.stdout?.toString() ?? "",
		stderr: proc.stderr?.toString() ?? "",
	};
}
