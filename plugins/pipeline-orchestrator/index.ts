/**
 * Pipeline Orchestrator — extension entry point v4
 *
 * Route-table based transitions with condition evaluation.
 * Backward compatible with v3 auto/llm/conditional/manual types.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents } from "./agents.js";
import { executePhase, runValidation } from "./pipeline.js";
import * as state from "./state.js";
import type { PipelineDefinition } from "./types.js";

const DEFAULT_MAX_ITER = 5;
const DEFAULT_MAX_RETRIES = 3;

const definitions = new Map<string, PipelineDefinition>();

/** Active run state */
let activeRun: {
	pipelineId: string;
	cancelled: boolean;
	stopped: boolean;
	// Parallel: per-entity LLM waiters replace the old global resolveLLM
	llmWaiters: Map<string, { resolve: (decision: string) => void; reject: (err: Error) => void; prompt: string }>;
} | null = null;

// ── Semaphore for entity concurrency ──
function createSemaphore(n: number) {
	if (!Number.isFinite(n) || n <= 0) {
		return { acquire: async () => {}, release: () => {}, running: () => 0 };
	}
	let available = n;
	const waiters: Array<() => void> = [];
	return {
		async acquire() {
			if (available > 0) { available--; return; }
			await new Promise<void>((r) => waiters.push(r));
		},
		release() {
			if (waiters.length > 0) { const w = waiters.shift(); if (w) w(); }
			else { available++; }
		},
		running() { return n - available + waiters.length; },
	};
}

export default function (pi: ExtensionAPI) {
	// ── Auto-load .pi/pipelines/*.json (project + global) ──
	function autoLoadDefinitions(cwd: string) {
		const dirs = [
			path.join(cwd, ".pi", "pipelines"),
			path.join(os.homedir(), ".pi", "agent", "pipelines"),
		];
		for (const dir of dirs) {
			if (!fs.existsSync(dir)) continue;
			for (const file of fs.readdirSync(dir).filter((f: string) => f.endsWith(".json"))) {
				try {
					const def = JSON.parse(
						fs.readFileSync(path.join(dir, file), "utf-8"),
					) as PipelineDefinition;
					if (def.name && def.phases?.length) definitions.set(def.name, def);
				} catch {
					/* skip */
				}
			}
		}
	}

	pi.on("session_start", async (_event: any, ctx: any) => {
		state.restoreFromEntries(ctx.sessionManager?.getEntries() ?? []);
		autoLoadDefinitions(ctx.cwd);
		// Load manifest/memory for iterative pipelines
		for (const [name, def] of definitions) {
			if (def.lifecycle === "iterative") {
				state.loadManifest(name);
				state.loadMemory(name);
			}
		}
	});

	/** Resolve {outputDir} template to actual path */
	function resolveOutputDir(
		def: PipelineDefinition,
		entityId: string,
		extraVars: Record<string, string>,
	): string | null {
		if (!def.outputDir) return null;
		let dir = def.outputDir;
		const vars: Record<string, string> = {
			...state.flattenVars(def.variables),
			...extraVars,
			entity: entityId,
		};
		for (const [k, v] of Object.entries(vars)) {
			dir = dir.replace(new RegExp(`\\{${k}\\}`, "g"), v);
		}
		return dir || null;
	}

	// ═══════════════════════════════════════════════════════════
	// Tool: pipeline_decide — LLM response to llm/manual transitions
	// ═══════════════════════════════════════════════════════════
	pi.registerTool({
		name: "pipeline_decide",
		label: "Pipeline Decide",
		description:
			"Respond to a pipeline decision point. Called by the LLM when the pipeline pauses for a decision.",
		parameters: Type.Object({
			pipelineId: Type.String({ description: "Pipeline ID" }),
			entityId: Type.String({ description: "Entity ID" }),
			decision: Type.String({
				description: '"pass", "loop", or next phase name',
			}),
		}),
		async execute(_toolCallId: any, params: any, _signal: any, _onUpdate: any, _ctx: any) {
			const record = state.getPipeline(params.pipelineId);
			if (!record)
				return {
					content: [{ type: "text", text: "Pipeline not found." }],
					isError: true,
				};

			// Parallel mode: per-entity LLM waiter
			if (activeRun?.llmWaiters) {
				const waiter = activeRun.llmWaiters.get(params.entityId);
				if (waiter) {
					activeRun.llmWaiters.delete(params.entityId);
					waiter.resolve(params.decision);
					return {
						content: [{ type: "text", text: `Decision "${params.decision}" for ${params.entityId}.` }],
					};
				}
			}

			// Manual advance (no active wait)
			const entity = record.entities[params.entityId];
			if (!entity)
				return {
					content: [{ type: "text", text: "Entity not found." }],
					isError: true,
				};

			state.updateEntity(
				(t, d) => pi.appendEntry(t, d),
				params.pipelineId,
				params.entityId,
				{ phase: params.decision, status: "pending", retries: 0 },
			);
			return {
				content: [
					{
						type: "text",
						text: `Entity "${params.entityId}" advanced to ${params.decision}.`,
					},
				],
			};
		},
	});

	// ═══════════════════════════════════════════════════════════
	// AUTO-EXECUTION ENGINE — runs inside /pipeline run command
	// ═══════════════════════════════════════════════════════════
	async function executePipelineRun(
		pipelineId: string,
		def: PipelineDefinition,
		entities: string[],
		extraVars: Record<string, string>,
		cwd: string,
		skillDir: string | undefined,
		appendEntry: (type: string, data: unknown) => void,
		onStatus: (msg: string) => void,
		signal?: AbortSignal,
	): Promise<{ success: boolean; summary: string }> {
		// Init state
		state.createPipeline(appendEntry, pipelineId, def, entities);
		activeRun = {
			pipelineId,
			cancelled: false,
			stopped: false,
			llmWaiters: new Map(),
		};
		const run = activeRun;
		const agents = discoverAgents(cwd, skillDir);
		onStatus(
			`Pipeline "${def.name}" started with ${entities.length} ${def.entityType}(s).`,
		);

		// Main execution loop — parallel entities with concurrency control
		const concurrency = def.concurrency ?? 0; // 0 = unlimited
		const sem = createSemaphore(concurrency);
		const parallel = concurrency <= 0 || concurrency > 1;
		if (parallel) {
			onStatus(`  (parallel mode, ${concurrency <= 0 ? "unlimited" : concurrency} concurrent)`);
		}

		const _log = parallel ? (() => {}) : (msg: string) => onStatus(msg);


		/** Aggregate status line for footer */
		const updateStatus = () => {
			const record = state.getPipeline(pipelineId);
			if (!record) return;
			const ents = Object.values(record.entities);
			const done = ents.filter(e => e.status === "completed").length;
			const running = ents.filter(e => e.status === "running").length;
			const waiting = run.llmWaiters.size;
			const icons: string[] = [];
			for (const e of ents) {
				if (e.status === "running" && run.llmWaiters.has(e.entityId)) icons.push(`💬${e.entityId}`);
				else if (e.status === "running") icons.push(`▶${e.entityId}`);
				else if (e.status === "completed") icons.push(`✓${e.entityId}`);
				else if (e.status === "failed") icons.push(`✗${e.entityId}`);
				else if (e.status === "skipped") icons.push(`○${e.entityId}`);
			}
			const parts = [`[${done}/${ents.length}]`];
			if (running > 0) parts.push(`${waiting > 0 ? `${waiting}💬+` : ""}${running}▶`);
			onStatus(parts.concat(icons.slice(0, 5)).join(" ").slice(-150));
		};

		/** Process a single entity through all phases (runs within semaphore) */
		async function processEntity(entityId: string): Promise<void> {
			// Acquire concurrency slot
			let _holdingSem = false;
			if (parallel) { await sem.acquire(); _holdingSem = true; }
			try {
				// Check entity dependencies
				const deps = def.entityDependencies?.[entityId];
				if (deps?.length) {
					while (true) {
						const allResolved = deps.every((depId: string) => {
							const dep = state.getPipeline(pipelineId)?.entities[depId];
							return dep && (dep.status === "completed" || dep.status === "failed" || dep.status === "skipped");
						});
						if (allResolved) break;
						await new Promise((r) => setTimeout(r, 2000));
					}
					const depFailed = deps.some((depId: string) => {
						const dep = state.getPipeline(pipelineId)?.entities[depId];
						return dep?.status === "failed";
					});
					if (depFailed) {
						state.updateEntity(appendEntry, pipelineId, entityId, {
							status: "skipped",
							error: "Dependency failed",
						});
						updateStatus();
						return;
					}
				}

				// Phase loop per entity
				_log(`\n── ${entityId} ──`);
				try {
					phaseLoop: while (true) {
					if (run.cancelled || run.stopped) {
						state.updateEntity(appendEntry, pipelineId, entityId, {
							status: run.cancelled ? "failed" : "pending",
							error: run.cancelled ? "Cancelled" : "Stopped — can resume",
						});
						updateStatus();
						return;
					}
					if (signal?.aborted) {
						state.updateEntity(appendEntry, pipelineId, entityId, {
							status: "failed",
							error: "Aborted",
						});
						updateStatus();
						return;
					}

					const entity = state.getPipeline(pipelineId)?.entities[entityId];
					if (!entity) return;
					if (entity.status === "failed") return;

					const currentBase = entity.phase.split("|")[0];
					const phaseDef = def.phases.find((p) => p.name === currentBase);
					if (!phaseDef) return;

					// Terminal state (or skipped)
					if (currentBase === "done") {
						state.updateEntity(appendEntry, pipelineId, entityId, { status: "completed" });
						updateStatus();
						return;
					}

					// ── skipIf evaluation ──
					if (phaseDef.skipIf) {
						const skipOutputDir = resolveOutputDir(def, entityId, extraVars) || "";
						const shouldSkip = state.evaluateSkipIf(
							phaseDef, entityId, extraVars,
							state.flattenVars(def.variables), skipOutputDir, cwd,
						);
						if (shouldSkip) {
							state.updateEntity(appendEntry, pipelineId, entityId, {
								status: "skipped",
								error: phaseDef.skipReason ?? "Skipped by skipIf condition",
							});
							updateStatus();
							return;
						}
					}

					// ── Route resolution helper ──
					const resolveRoute = (exitCode: number, validatePassed: boolean, agentOutput: string) =>
						state.resolveRouteNext(pipelineId, entityId, {
							exitCode, validatePassed, agentOutput, cwd, extraVars,
						});

					// ── Handle special route markers ──
					const handleSpecialRoute = async (
						routeResult: { next: string | null; iter: boolean; prompt?: string; loopId?: string },
						currentEntity: { iter: number },
					): Promise<{ handled: boolean; breakLoop?: boolean }> => {
						if (!routeResult.next) return { handled: true, breakLoop: true };

						if (routeResult.next === "__LLM__") {
							let llmPrompt = routeResult.prompt ?? "Please review and call pipeline_decide().";
							const allVars: Record<string, string> = {
								...state.flattenVars(def.variables), ...extraVars,
								entity: entityId, pipelineId,
							};
							for (const [k, v] of Object.entries(allVars)) {
								llmPrompt = llmPrompt.replace(new RegExp(`\\{${k}\\}`, "g"), v);
							}
							pi.sendUserMessage(llmPrompt, { deliverAs: "followUp" });

							// Release semaphore while waiting for LLM (let other entities run)
							if (parallel) { sem.release(); _holdingSem = false; }
							updateStatus();
							try {
								const decision = await new Promise<string>((resolve, reject) => {
									run.llmWaiters.set(entityId, { resolve, reject, prompt: llmPrompt });
								});

								const newIter = currentEntity.iter + (routeResult.iter ? 1 : 0);
								const maxIter = def.maxIterations ?? DEFAULT_MAX_ITER;
								if (routeResult.iter && maxIter > 0 && newIter >= maxIter) {
									state.updateEntity(appendEntry, pipelineId, entityId, {
										status: "failed",
										error: `Max iterations (${maxIter}) reached`,
									});
									updateStatus();
									return { handled: true, breakLoop: true };
								}
								state.updateEntity(appendEntry, pipelineId, entityId, {
									phase: decision, status: "pending", retries: 0, iter: newIter,
								});
							} finally {
								if (parallel) { await sem.acquire(); _holdingSem = true; }
							}
							updateStatus();
							return { handled: true };
						}

						if (routeResult.next === "__COND__") {
							// Release semaphore while waiting
							if (parallel) { sem.release(); _holdingSem = false; }
							updateStatus();
							try {
								const decision = await new Promise<string>((resolve, reject) => {
									run.llmWaiters.set(entityId, { resolve, reject, prompt: `Conditional: ${currentBase}` });
								});
								const trans = phaseDef.transition;
								let nextPhase = decision;
								if ("type" in trans && trans.type === "conditional") {
									nextPhase = decision === "pass" ? trans.pass : decision === "loop" ? trans.loop : decision;
								}
								const newIter = currentEntity.iter + (decision === "loop" ? 1 : 0);
								const maxIter = def.maxIterations ?? DEFAULT_MAX_ITER;
								if (decision === "loop" && maxIter > 0 && newIter >= maxIter) {
									state.updateEntity(appendEntry, pipelineId, entityId, {
										status: "failed",
										error: `Max iterations (${maxIter}) reached`,
									});
									updateStatus();
									return { handled: true, breakLoop: true };
								}
								state.updateEntity(appendEntry, pipelineId, entityId, {
									phase: nextPhase, status: "pending", retries: 0, iter: newIter,
								});
							} finally {
								if (parallel) { await sem.acquire(); _holdingSem = true; }
							}
							updateStatus();
							return { handled: true };
						}

						if (routeResult.next === "__MANUAL__") {
							if (parallel) { sem.release(); _holdingSem = false; }
							updateStatus();
							try {
								const decision = await new Promise<string>((resolve, reject) => {
									run.llmWaiters.set(entityId, { resolve, reject, prompt: `Manual: ${currentBase}` });
								});
								state.updateEntity(appendEntry, pipelineId, entityId, {
									phase: decision, status: "pending", retries: 0,
								});
							} finally {
								if (parallel) { await sem.acquire(); _holdingSem = true; }
							}
							updateStatus();
							return { handled: true };
						}

						return { handled: false };
					};

					// ── No-agent phase ──
					if (!phaseDef.agent) {
						const route = resolveRoute(0, true, "");
						const spec = await handleSpecialRoute(route, entity);
						if (spec.breakLoop) return;
						if (spec.handled) continue;

						const next = route.next ?? "done";
						state.updateEntity(appendEntry, pipelineId, entityId, {
							phase: next, status: "completed", retries: 0,
						});
						if (next === "done") return;
						continue;
					}

					const agent = agents.get(phaseDef.agent);
					if (!agent) {
						state.updateEntity(appendEntry, pipelineId, entityId, {
							status: "failed",
							error: `Agent "${phaseDef.agent}" not found`,
						});
						updateStatus();
						return;
					}

					// ── Retry loop for this phase ──
					let retries = 0;
					const maxRetries = phaseDef.maxRetries ?? DEFAULT_MAX_RETRIES;

					while (retries < maxRetries) {
						if (run.cancelled || signal?.aborted) break;

						state.updateEntity(appendEntry, pipelineId, entityId, { status: "running", retries });
						updateStatus();

						const taskPrompt = state.renderTaskTemplate(pipelineId, entityId, extraVars);
						const logDir = resolveOutputDir(def, entityId, extraVars);
						_log(`  ▶ ${currentBase} [${phaseDef.agent}]${retries > 0 ? ` (retry ${retries})` : ""}`);

						const result = await executePhase(
							entityId, phaseDef, agent, taskPrompt, cwd,
							undefined, undefined,
							logDir ? path.join(logDir, `.agent-${currentBase}.log`) : undefined,
							retries,
							{ ...state.flattenVars(def.variables), ...extraVars, entity: entityId },
						);

						// Save agent output
						if (result.output) {
							const updatedEntity = state.getPipeline(pipelineId)?.entities[entityId];
							if (updatedEntity) {
								const phaseOutputs = { ...(updatedEntity.phaseOutputs ?? {}) };
								phaseOutputs[currentBase] = result.output;
								state.updateEntity(appendEntry, pipelineId, entityId, {
									lastOutput: result.output, phaseOutputs,
								});
							}
							if (logDir) {
								try {
									fs.mkdirSync(logDir, { recursive: true });
									if (result.tracePath) {
										try {
											const dest = path.join(logDir, `.agent-${currentBase}.trace.jsonl`);
											fs.copyFileSync(result.tracePath, dest);
											fs.unlinkSync(result.tracePath);
											fs.rmSync(path.dirname(result.tracePath), { recursive: true });
										} catch { /* non-critical */ }
									}
								} catch { /* non-critical */ }
							}
						}

						// Auto-version declared output files
						if (phaseDef.versionOutputs?.length) {
							const outDir = resolveOutputDir(def, entityId, extraVars);
							if (outDir) state.versionOutputFiles(phaseDef, entity.iter ?? 0, outDir);
						}

						if (result.exitCode !== 0 || result.error) {
							retries++;
							if (retries >= maxRetries) {
								state.updateEntity(appendEntry, pipelineId, entityId, {
									status: "failed", retries,
									error: `Phase "${currentBase}" failed: ${result.error || result.stderr}`,
								});
								updateStatus();
								return;
							}
							continue;
						}

						// Validation
						if (phaseDef.validate) {
							const v = phaseDef.validate;
							let valCmd: string = typeof v === "string" ? v : (v as any).bash || "";
							const outputDir = resolveOutputDir(def, entityId, extraVars) || "";
							const allVars: Record<string, string> = {
								...state.flattenVars(def.variables), ...extraVars,
								entity: entityId, pipelineId, outputDir,
							};
							for (const [k, v] of Object.entries(allVars)) {
								valCmd = valCmd.replace(new RegExp(`\\{${k}\\}`, "g"), v);
							}
							const valResult = await runValidation(valCmd, cwd);
							if (!valResult.passed) {
								retries++;
								if (retries >= maxRetries) {
									state.updateEntity(appendEntry, pipelineId, entityId, {
										status: "failed", retries,
										error: `Validation failed: ${valResult.stderr.slice(0, 500)}`,
									});
									updateStatus();
									return;
								}
								continue;
							}
						}

						// Build PhaseSummary from agent output
					if (result.output) {
						let summaryVerdict = "UNCLEAR";
						if (result.output.includes("PASS")) summaryVerdict = "PASS";
						else if (result.output.includes("FAIL") || result.output.includes("NOT PASS")) summaryVerdict = "FAIL";
						const findings: string[] = [];
						const phrases = ["VERDICT", "DECISION", "ERROR", "WARN"];
						for (const line of result.output.split("\n")) {
							if (phrases.some((p) => line.includes(p))) findings.push(line.trim().slice(0, 120));
							if (findings.length >= 3) break;
						}
						state.updateEntity(appendEntry, pipelineId, entityId, {
							phaseSummaries: { ...(entity.phaseSummaries || {}), [currentBase]: { verdict: summaryVerdict, keyFindings: findings } },
						});
					}

					// Resolve next phase via route table
						const route = resolveRoute(0, true, result.output || "");
						const spec = await handleSpecialRoute(route, entity);
						if (spec.breakLoop) return;
						if (spec.handled) continue phaseLoop;

						// Normal route advance
						const finalPhase = route.next ?? "done";
						const lid = route.loopId || "__global__";
						const counters = { ...entity.loopCounters };
						if (route.iter) {
							counters[lid] = (counters[lid] || 0) + 1;
							const maxIter = def.maxIterationsPerLoop?.[lid]
								?? def.maxIterations
								?? DEFAULT_MAX_ITER;
							if (counters[lid] >= maxIter) {
								state.updateEntity(appendEntry, pipelineId, entityId, {
									status: "failed", error: `Max iterations for ${lid} (${maxIter}) reached`,
									loopCounters: counters,
								});
								updateStatus();
								return;
							}
						}
						state.updateEntity(appendEntry, pipelineId, entityId, {
							phase: finalPhase, status: "completed", retries: 0, loopCounters: counters,
							iter: entity.iter + (route.iter ? 1 : 0),
						});

						if (finalPhase === "done") return;
						continue phaseLoop;
					}

					// Exhausted retries → entity failed
					return;
				}
				} catch (err: any) {
					// LLM waiter rejection (cancel/stop) or unexpected error
					if (!run.cancelled && !run.stopped) {
						state.updateEntity(appendEntry, pipelineId, entityId, {
							status: "failed",
							error: `Error: ${err?.message || err}`,
						});
					}
					updateStatus();
					return;
				}
			} finally {
				// Release semaphore (only if still holding — not released for LLM wait)
				if (parallel && _holdingSem) sem.release();
			}
		}

		// ── Launch all entities as workers ──
		if (parallel) {
			await Promise.allSettled(entities.map(id => processEntity(id)));
		} else {
			// Serial: process one by one (compatible, simpler debug)
			for (const entityId of entities) {
				await processEntity(entityId);
				if (activeRun.cancelled || activeRun.stopped) break;
			}
		}
		// Final summary
		activeRun = null;
		const summary = state.summarizePipeline(pipelineId);
		const failed = Object.values(
			state.getPipeline(pipelineId)?.entities ?? {},
		).filter((e) => e.status === "failed").length;
		return {
			success: failed === 0,
			summary: `Pipeline complete. ${entities.length - failed}/${entities.length} succeeded.\n\n${summary}`,
		};
	}

	// ═══════════════════════════════════════════════════════════
	// Command: /pipeline run <name> — BLOCKING EXECUTION
	// ═══════════════════════════════════════════════════════════
	pi.registerCommand("pipeline", {
		description: "Pipeline control: run <name> | cancel <id> | status | list",
		handler: async (args: any, ctx: any) => {
			const parts = (args || "").trim().split(/\s+/);
			const sub = parts[0] || "status";

			// ── /pipeline list ──
			if (sub === "list") {
				const defs = Array.from(definitions.keys());
				if (defs.length === 0) {
					ctx.ui.notify(
						"No pipeline definitions found. Add JSON files to .pi/pipelines/",
						"info",
					);
				} else {
					ctx.ui.notify(`Available: ${defs.join(", ")}`, "info");
				}
				return;
			}

			// ── /pipeline cancel <id> ──
			if (sub === "cancel" && parts[1]) {
				if (activeRun && activeRun.pipelineId === parts[1]) {
					activeRun.cancelled = true;
					if (activeRun.llmWaiters) { for (const [, w] of activeRun.llmWaiters) w.reject(new Error("Cancelled")); activeRun.llmWaiters.clear(); };
					ctx.ui.notify(`Pipeline "${parts[1]}" cancelling...`, "warning");
				} else {
					const record = state.getPipeline(parts[1]);
					if (record) {
						for (const e of Object.values(record.entities)) {
							if (e.status !== "completed" && e.status !== "failed") {
								state.updateEntity(
									(t, d) => pi.appendEntry(t, d),
									parts[1],
									e.entityId,
									{ status: "failed", error: "Cancelled by user" },
								);
							}
						}
						ctx.ui.notify(`Pipeline "${parts[1]}" cancelled.`, "info");
					} else {
						ctx.ui.notify(`Pipeline "${parts[1]}" not found.`, "error");
					}
				}
				return;
			}

			// ── /pipeline run <name> [--entity <id>] [--vars k=v,...] ──
			if (sub === "run" && parts[1]) {
				const pipelineName = parts[1];
				const def = definitions.get(pipelineName);
				if (!def) {
					const avail = Array.from(definitions.keys()).join(", ") || "none";
					ctx.ui.notify(
						`Pipeline "${pipelineName}" not found. Available: ${avail}`,
						"error",
					);
					return;
				}

				// Parse extra args
				let entityFilter: string | null = null;
				const extraVars: Record<string, string> = {};
				for (let i = 2; i < parts.length; i++) {
					if (parts[i] === "--entity" && parts[i + 1]) {
						entityFilter = parts[++i];
					} else if (parts[i] === "--vars" && parts[i + 1]) {
						for (const kv of parts[++i].split(",")) {
							const [k, v] = kv.split("=");
							if (k && v) extraVars[k] = v;
						}
					}
				}

				// Discover entities (generic: substitute ALL pipeline vars)
				let entities: string[];
				if (entityFilter) {
					entities = [entityFilter];
				} else if (def.entityDiscovery?.pattern) {
				let qDir = def.entityDiscovery.pattern;
				try {
					const allVars = { ...state.flattenVars(def.variables), ...extraVars };
					for (const [k, v] of Object.entries(allVars)) {
						if (v) qDir = qDir.replace(new RegExp(`\\{${k}\\}`, "g"), v);
					}
					entities = fs
						.readdirSync(qDir, { withFileTypes: true })
						.filter((d: fs.Dirent) => d.isDirectory())
						.map((d: fs.Dirent) => d.name);
					// Apply exclusion list
					if (def.entityDiscovery.exclude?.length) {
						const excl = new Set(def.entityDiscovery.exclude);
						entities = entities.filter((e) => !excl.has(e));
					}
				} catch (err: any) {
					ctx.ui.notify(
						`Cannot auto-discover entities. Resolved: ${qDir} → ${err?.message || err}`,
						"error",
					);
					return;
				}
				} else {
					ctx.ui.notify(
						`Provide --entity <id> or set --vars study_dir=... for auto-discovery.`,
						"error",
					);
					return;
				}

				if (entities.length === 0) {
					ctx.ui.notify("No entities to process.", "info");
					return;
				}

				// Inject variables from pipeline definition defaults
				const flatVars = state.flattenVars(def.variables);
				for (const [k, v] of Object.entries(flatVars)) {
					if (!extraVars[k] && v) extraVars[k] = v;
				}

				// Check for existing incomplete pipeline to resume
				const existing = state.findIncompleteByName(pipelineName);
				let pipelineId: string;
				if (existing) {
					pipelineId = existing.pipelineId;
					// Filter to only pending/failed entities from existing pipeline
					const existingEntities = Object.keys(existing.entities);
					const pendingEntities = entities.filter(
						(id) =>
							existingEntities.includes(id) &&
							existing.entities[id].status !== "completed",
					);
					if (pendingEntities.length > 0) {
						entities = pendingEntities;
						ctx.ui.notify(
							`Resuming pipeline "${pipelineId}" with ${entities.length} pending entities...`,
							"info",
						);
					} else {
						// All existing entities completed, start fresh
						pipelineId = `${pipelineName}-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}`;
						ctx.ui.notify(
							`All previous entities completed. Starting new pipeline "${pipelineId}"...`,
							"info",
						);
					}
				} else {
					pipelineId = `${pipelineName}-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}`;
					ctx.ui.notify(
						`Starting pipeline "${pipelineId}" with ${entities.length} entities...`,
						"info",
					);
				}

				// ── BLOCKING EXECUTION ──
				const result = await executePipelineRun(
					pipelineId,
					def,
					entities,
					extraVars,
					ctx.cwd,
					extraVars.skill_dir || extraVars.skillDir,
					(t, d) => pi.appendEntry(t, d),
					(msg) => {
						// Footer: compact at-a-glance status
						ctx.ui.setStatus("pipeline", msg.replace(/\n/g, " | ").slice(-100));
					},
					undefined,
				);

				ctx.ui.notify(result.summary, result.success ? "info" : "warning");
				ctx.ui.notify(
					"Pipeline execution complete. Pi returned to normal.",
					"info",
				);
				return;
			}

			// ── /pipeline stop <id> ──
			if (sub === "stop" && parts[1]) {
				if (activeRun && activeRun.pipelineId === parts[1]) {
					activeRun.stopped = true;
					if (activeRun.llmWaiters) { for (const [, w] of activeRun.llmWaiters) w.reject(new Error("Stopped")); activeRun.llmWaiters.clear(); };
					ctx.ui.notify(
						`Pipeline "${parts[1]}" stopping... Entities keep current state.`,
						"warning",
					);
				} else {
					ctx.ui.notify(
						`Pipeline "${parts[1]}" is not currently running.`,
						"info",
					);
				}
				return;
			}

			// ── /pipeline status (default) ──
			const all = state.getAllPipelines();
			if (all.length === 0) {
				const defs = Array.from(definitions.keys());
				ctx.ui.notify(
					defs.length > 0
						? `Available: ${defs.join(", ")}. /pipeline run <name> to start.`
						: "No pipelines.",
					"info",
				);
				return;
			}
			for (const r of all) {
				ctx.ui.notify(state.summarizePipeline(r.pipelineId), "info");
			}
		},
	});

	// ═══════════════════════════════════════════════════════════
	// Keep legacy tools for LLM-driven usage
	// ═══════════════════════════════════════════════════════════
	pi.registerTool({
		name: "pipeline_stop",
		label: "Pipeline Stop",
		description:
			"Stop a running pipeline. Entities keep current state. Can be resumed by re-running /pipeline run.",
		parameters: Type.Object({
			pipelineId: Type.String({ description: "Pipeline ID" }),
		}),
		async execute(_id: any, params: any) {
			if (activeRun && activeRun.pipelineId === params.pipelineId) {
				activeRun.stopped = true;
				if (activeRun.llmWaiters) { for (const [, w] of activeRun.llmWaiters) w.reject(new Error("Stopped")); activeRun.llmWaiters.clear(); };
			}
			return {
				content: [
					{
						type: "text",
						text: `Pipeline "${params.pipelineId}" stop signal sent.`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "pipeline_status",
		label: "Pipeline Status",
		description: "Show pipeline states.",
		parameters: Type.Object({
			pipelineId: Type.Optional(Type.String({ description: "Pipeline ID" })),
		}),
		async execute(_id: any, params: any) {
			if (params.pipelineId) {
				return {
					content: [
						{ type: "text", text: state.summarizePipeline(params.pipelineId) },
					],
				};
			}
			const all = state.getAllPipelines();
			return {
				content: [
					{
						type: "text",
						text:
							all.length === 0
								? "No active pipelines."
								: all
										.map((r) => state.summarizePipeline(r.pipelineId))
										.join("\n\n---\n\n"),
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "pipeline_cancel",
		label: "Pipeline Cancel",
		description: "Cancel a pipeline run.",
		parameters: Type.Object({
			pipelineId: Type.String({ description: "Pipeline ID" }),
		}),
		async execute(_id: any, params: any) {
			if (activeRun && activeRun.pipelineId === params.pipelineId) {
				activeRun.cancelled = true;
				if (activeRun.llmWaiters) { for (const [, w] of activeRun.llmWaiters) w.reject(new Error("Cancelled")); activeRun.llmWaiters.clear(); };
			}
			const record = state.getPipeline(params.pipelineId);
			if (!record) return { content: [{ type: "text", text: "Not found." }] };
			for (const e of Object.values(record.entities)) {
				if (e.status !== "completed" && e.status !== "failed") {
					state.updateEntity(
						(t, d) => pi.appendEntry(t, d),
						params.pipelineId,
						e.entityId,
						{ status: "failed", error: "Cancelled" },
					);
				}
			}
			return {
				content: [
					{ type: "text", text: `Pipeline "${params.pipelineId}" cancelled.` },
				],
			};
		},
	});
}
