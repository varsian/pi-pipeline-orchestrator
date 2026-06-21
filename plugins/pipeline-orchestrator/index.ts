/**
 * Pipeline Orchestrator — extension entry point v5 (omp)
 *
 * Route-table based transitions with condition evaluation.
 * Backward compatible with v3 auto/llm/conditional/manual types.
 * Ported from pi to omp: SDK createAgentSession replaces spawn("pi",...).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
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
	// Also checks .omp/pipelines for omp-native paths.
	function autoLoadDefinitions(cwd: string) {
		const dirs = [
			path.join(cwd, ".pi", "pipelines"),
			path.join(cwd, ".omp", "pipelines"),
			path.join(os.homedir(), ".pi", "agent", "pipelines"),
			path.join(os.homedir(), ".omp", "agent", "pipelines"),
		];
		for (const dir of dirs) {
			if (!fs.existsSync(dir)) continue;
			for (const file of fs.readdirSync(dir).filter((f: string) => f.endsWith(".json"))) {
				try {
					const raw = fs.readFileSync(path.join(dir, file), "utf-8");
					const def = JSON.parse(raw) as PipelineDefinition;
					const errors = validatePipelineDefinition(def);
					if (errors.length > 0) {
						pi.logger?.warn(
							`Skipping invalid pipeline "${file}": ${errors.join("; ")}`,
						);
						continue;
					}
					definitions.set(def.name, def);
				} catch (err: unknown) {
					pi.logger?.warn(
						`Failed to load pipeline "${file}": ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}
	}

	/** Validate a pipeline definition. Returns array of error messages (empty = valid). */
	function validatePipelineDefinition(def: unknown): string[] {
		const errors: string[] = [];
		if (!def || typeof def !== "object") return ["not an object"];
		const d = def as Record<string, unknown>;

		if (typeof d.name !== "string" || !d.name.trim())
			errors.push("name is required");
		if (!Array.isArray(d.phases) || d.phases.length === 0)
			errors.push("phases must be a non-empty array");

		const validPhaseNames = new Set<string>();
		const seenNames = new Set<string>();
		if (Array.isArray(d.phases)) {
			for (let i = 0; i < d.phases.length; i++) {
				const p = d.phases[i] as Record<string, unknown> | undefined;
				if (!p) {
					errors.push(`phases[${i}]: missing`);
					continue;
				}
				const pname = p.name;
				if (typeof pname !== "string" || !pname.trim()) {
					errors.push(`phases[${i}]: name is required`);
				} else {
					if (seenNames.has(pname)) {
						errors.push(`phases[${i}]: duplicate phase name "${pname}"`);
					} else {
						seenNames.add(pname);
					}
					validPhaseNames.add(pname);
				}

				if (typeof p.agent !== "string" && p.agent !== undefined)
					errors.push(`phases[${i}] (${String(pname || i)}): agent must be a string or absent`);

				// taskTemplate must be object with template field
				const tt = p.taskTemplate;
				if (tt !== undefined && tt !== null) {
					if (typeof tt !== "object") {
						errors.push(
							`phases[${i}] (${String(pname || i)}): taskTemplate must be an object, got ${typeof tt}`,
						);
					} else {
						const tto = tt as Record<string, unknown>;
						if (typeof tto.template !== "string")
							errors.push(
								`phases[${i}] (${String(pname || i)}): taskTemplate.template is required`,
							);
					}
				}

				// Validate transition routes
				const trans = p.transition as Record<string, unknown> | undefined;
				if (trans && "routes" in trans && Array.isArray(trans.routes)) {
					for (let j = 0; j < trans.routes.length; j++) {
						const route = trans.routes[j] as Record<string, unknown>;
						const next = route.next;
						if (typeof next !== "string") {
							errors.push(
								`phases[${i}].routes[${j}]: next must be a string`,
							);
						} else if (
							next !== "done" &&
							next !== "__LLM__" &&
							next !== "__COND__" &&
							next !== "__MANUAL__" &&
							next !== "__NEXT__" &&
							!validPhaseNames.has(next)
						) {
							// Check after all phases processed (deferred)
						}
					}
				}

				// Deprecated conditional type
				if (
					trans &&
					"type" in trans &&
					trans.type === "conditional"
				) {
					errors.push(
						`phases[${i}] (${String(pname || i)}): "conditional" transition type is deprecated — use routes or "llm" type`,
					);
				}
			}
		}

		// Validate route targets reference valid phases (deferred)
		if (Array.isArray(d.phases)) {
			for (let i = 0; i < d.phases.length; i++) {
				const p = d.phases[i] as Record<string, unknown> | undefined;
				if (!p) continue;
				const trans = p.transition as Record<string, unknown> | undefined;
				if (trans && "routes" in trans && Array.isArray(trans.routes)) {
					for (let j = 0; j < trans.routes.length; j++) {
						const route = trans.routes[j] as Record<string, unknown>;
						const next = route.next;
						if (
							typeof next === "string" &&
							next !== "done" &&
							next !== "__LLM__" &&
							next !== "__COND__" &&
							next !== "__MANUAL__" &&
							next !== "__NEXT__" &&
							next !== "__SELF__" &&
							!validPhaseNames.has(next)
						) {
							errors.push(
								`phases[${i}].routes[${j}]: next "${next}" is not a valid phase name`,
							);
						}
						if (typeof next === "string" && (next === "__NEXT__" || next === "__SELF__")) {
							errors.push(
								`phases[${i}].routes[${j}]: next "${next}" is a placeholder that must be translated to an actual phase name`,
							);
						}
					}
				}
			}
		}

		// Cycle detection via DFS
		if (Array.isArray(d.phases) && errors.length === 0) {
			const graph = new Map<string, string[]>();
			for (const p of d.phases as Array<Record<string, unknown>>) {
				const from = p.name as string;
				const targets: string[] = [];
				const trans = p.transition as Record<string, unknown> | undefined;
				if (trans && "routes" in trans && Array.isArray(trans.routes)) {
					for (const r of trans.routes as Array<Record<string, unknown>>) {
						const n = r.next as string;
						if (n && n !== "done" && n !== "__LLM__" && n !== "__COND__" && n !== "__MANUAL__" && n !== "__NEXT__" && validPhaseNames.has(n)) {
							targets.push(n);
						}
					}
				}
				graph.set(from, targets);
			}
			const color = new Map<string, number>();
			const cycle = (node: string): boolean => {
				const c = color.get(node) ?? 0;
				if (c === 1) return true;
				if (c === 2) return false;
				color.set(node, 1);
				for (const next of graph.get(node) ?? []) {
					if (cycle(next)) return true;
				}
				color.set(node, 2);
				return false;
			};
			for (const node of graph.keys()) {
				if (cycle(node)) {
					errors.push("route graph contains a cycle — add an exit condition (e.g. maxIterations or a 'done' route)");
					break;
				}
			}
		}

		// entityDiscovery.pattern must not contain {entity}
		const ed = d.entityDiscovery as Record<string, unknown> | undefined;
		if (ed && typeof ed.pattern === "string" && ed.pattern.includes("{entity}")) {
			errors.push(
				"entityDiscovery.pattern must not contain {entity} — it resolves at discovery time",
			);
		}

		// skill_dir should be absolute
		const vars = d.variables as Record<string, unknown> | undefined;
		if (vars) {
			const skillDir = vars.skill_dir;
			if (
				typeof skillDir === "object" &&
				skillDir !== null &&
				"default" in skillDir
			) {
				const sd = skillDir as { default: string };
				if (sd.default && !sd.default.startsWith("/") && !sd.default.startsWith("~")) {
					errors.push(
						"variables.skill_dir.default should be an absolute path",
					);
				}
			}
		}

		// maxIterations must be positive integer if present
		if (
			d.maxIterations !== undefined &&
			(typeof d.maxIterations !== "number" || d.maxIterations < 1)
		) {
			errors.push("maxIterations must be a positive integer");
		}

		return errors;
	}

	/** Generate a Mermaid flowchart from a pipeline definition. */
	function generateGraph(def: PipelineDefinition): string {
		const lines: string[] = ["```mermaid", "flowchart TD"];
		const phaseNames = def.phases.map((p) => p.name);

		// Start node
		lines.push(`  start(["START"]) --> ${phaseNames[0]}`);

		for (let i = 0; i < def.phases.length; i++) {
			const p = def.phases[i];
			const label = p.label || p.name;
			const agent = p.agent ? `<br/><i>${p.agent}</i>` : "";
			lines.push(`  ${p.name}["${label}${agent}"]`);

			const trans = p.transition;
			if ("routes" in trans && trans.routes) {
				for (let j = 0; j < trans.routes.length; j++) {
					const r = trans.routes[j];
					const cond =
						r.if === true
							? "else"
							: typeof r.if === "object"
								? (r.if as Record<string, unknown>).outputContains
									? `"${(r.if as Record<string, unknown>).outputContains}"`
									: (r.if as Record<string, unknown>).exitCode !== undefined
										? `exit=${(r.if as Record<string, unknown>).exitCode}`
										: "?"
								: "?";
					const next =
						r.next === "__LLM__"
							? "llm(["💬 LLM"])"
							: r.next === "done"
								? "done(["✅ done"])"
								: r.next;
					const style = r.iter ? " -.->|loop| " : " -->|";
					lines.push(`  ${p.name}${style}${cond}| ${next}`);
				}
			} else if ("type" in trans) {
				if (trans.type === "auto") {
					const next =
						i < def.phases.length - 1
							? phaseNames[i + 1]
							: "done";
					lines.push(
						`  ${p.name} -->${next === "done" ? ` done(["✅ done"])` : ` ${next}`}`,
					);
				} else if (trans.type === "llm") {
					lines.push(`  ${p.name} --> llm(["💬 LLM"])`);
				} else if (trans.type === "conditional") {
					lines.push(`  ${p.name} -->|pass| ${trans.pass}`);
					lines.push(`  ${p.name} -->|loop| ${trans.loop}`);
				}
			}
		}

		// Concurrency note
		if (def.concurrency && def.concurrency > 1) {
			lines.push(
				`  classDef concurrent fill:#e1f5fe,stroke:#0288d1;`,
			);
		}
		if (def.maxIterations) {
			const note = `maxIter=${def.maxIterations}`;
			lines.push(`  note["📋 ${note}"]`);
		}

		lines.push("```");
		return lines.join("\n");
	}

	pi.on(
		"session_start",
		async (
			_event: unknown,
			ctx: {
				cwd: string;
				sessionManager?: {
					getBranch(): Array<{
						type: string;
						customType?: string;
						data?: unknown;
					}>;
				};
			},
		) => {
			// Primary restore from session entries
			const branch = ctx.sessionManager?.getBranch() ?? [];
			state.restoreFromEntries(branch);

			// Fallback: if no pipeline state from session, try memory://
			if (state.getAllPipelines().length === 0 && pi.memory) {
				try {
					const memData =
						await pi.memory.load("pipeline-state");
					if (memData) {
						state.restoreFromEntries([
							{
								type: "custom",
								customType: "pipeline-state",
								data: memData,
							},
						]);
					}
				} catch {
					/* best-effort */
				}
			}

			state.resetStrandedEntities();

			autoLoadDefinitions(ctx.cwd);

			// Recover pending LLM waiters after restart
			if (pi.memory) {
				for (const rec of state.getAllPipelines()) {
					for (const ent of Object.values(rec.entities)) {
						if (ent.status !== "running") continue;
						const wd = await pi.memory.load(`llm-waiter-${ent.entityId}`);
						if (wd && typeof (wd as Record<string,unknown>).prompt === "string") {
							pi.sendUserMessage(
								`Pipeline "${rec.definition.name}" entity "${ent.entityId}" has a pending LLM decision. Prompt: ${(wd as Record<string,unknown>).prompt}\n\nUse pipeline_decide to resume.`,
								{ deliverAs: "followUp" },
							);
						}
					}
				}
			}
		},
	);
	/** Resolve {outputDir} template to actual path. Supports --vars outputDir=... override. */
	function resolveOutputDir(
		def: PipelineDefinition,
		entityId: string,
		extraVars: Record<string, string>,
		pipelineId: string,
	): string | null {
		// Allow --vars outputDir=/custom/path override
		if (extraVars.outputDir) {
			let dir = extraVars.outputDir;
			dir = dir.replace(/\{entity\}/g, entityId);
			return dir || null;
		}
		if (!def.outputDir) return null;
		let dir = def.outputDir;
		const vars: Record<string, string> = {
			...state.flattenVars(def.variables),
			...extraVars,
			entity: entityId,
			pipelineId,
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
		parameters: pi.typebox.Type.Object({
			pipelineId: pi.typebox.Type.String({ description: "Pipeline ID" }),
			entityId: pi.typebox.Type.String({ description: "Entity ID" }),
			decision: pi.typebox.Type.String({
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
					if (pi.memory) {
						void pi.memory.save(`llm-waiter-${params.entityId}`, null);
					}
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
		// Init state with memory backup
		state.createPipeline(appendEntry, pipelineId, def, entities, (record) => {
			if (pi.memory) {
				void pi.memory.save("pipeline-state", record);
			}
		});
		pi.logger?.info("Pipeline started", { pipelineId, name: def.name, entities: entities.length });
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




		const _log = (msg: string) => pi.logger?.info(msg);

		/** Build real-time pipeline status widget (max 10 lines) */
		const updateStatus = () => {
			const record = state.getPipeline(pipelineId);
			if (!record) return;
			const ents = Object.values(record.entities);
			const done = ents.filter(e => e.status === "completed").length;
			const failed = ents.filter(e => e.status === "failed").length;
			const running = ents.filter(e => e.status === "running").length;
			const waiting = run.llmWaiters.size;

			const lines: string[] = [];
			// Header: progress bar
			const barLen = 20;
			const filled = Math.round((done / ents.length) * barLen) || 0;
			const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
			const statusIcons: string[] = [];
			if (running > 0) statusIcons.push(`${running}▶`);
			if (waiting > 0) statusIcons.push(`${waiting}💬`);
			if (failed > 0) statusIcons.push(`${failed}✗`);
			lines.push(`┌─ ${def.name}  [${done+failed}/${ents.length}] ${bar} ${statusIcons.join(" ")}`.slice(0, 70));

			// Phase flow: compact row showing each entity's position
			const phaseNames = def.phases.map(p => p.name);
			const maxPhases = Math.min(phaseNames.length, 8);
			const phaseLabels = phaseNames.slice(0, maxPhases).map(n => n.slice(0, 6));
			lines.push(`│  ${phaseLabels.join(" · ")}`);

			// Per-entity status (up to 6 entities)
			const activeEnts = ents
				.filter(e => e.status !== "completed")
				.slice(0, 6);
			const completedCount = ents.filter(e => e.status === "completed").length;
			for (const e of activeEnts) {
				const icon = e.status === "running" && run.llmWaiters.has(e.entityId) ? "💬"
					: e.status === "running" ? "▶"
					: e.status === "failed" ? "✗"
					: e.status === "skipped" ? "○"
					: "⏳";
				const phaseIdx = phaseNames.indexOf(e.phase.split("|")[0]);
				const pos = phaseIdx >= 0 ? `→${e.phase.slice(0, 10)}` : e.phase.slice(0, 10);
				const name = e.entityId.slice(0, 15);
				lines.push(`│ ${icon} ${name.padEnd(16)} ${pos}`);
			}
			if (completedCount > 0 && activeEnts.length < 6) {
				lines.push(`│ ✓ ${completedCount} completed`);
			}
			if (ents.length - activeEnts.length - completedCount > 0) {
				const remaining = ents.length - activeEnts.length - completedCount;
				lines.push(`│   ... ${remaining} more`);
			}
			lines.push(`└─ /pipeline stop ${pipelineId}  │  /pipeline status`);

			onStatus(lines.join("\n"));
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
					// Release semaphore while waiting (prevent deadlock)
					if (parallel) { sem.release(); _holdingSem = false; }
					try {
						let waited = 0;
						while (waited < 300) { // 10-minute cycle-detection timeout
							const allResolved = deps.every((depId: string) => {
								const dep = state.getPipeline(pipelineId)?.entities[depId];
								return dep && (dep.status === "completed" || dep.status === "failed" || dep.status === "skipped");
							});
							if (allResolved) break;
							await new Promise((r) => setTimeout(r, 2000));
							waited += 2;
						}
						if (waited >= 300) {
							state.updateEntity(appendEntry, pipelineId, entityId, {
								status: "failed",
								error: "Dependency timeout (possible circular dependency)",
							});
							updateStatus();
							return;
						}
					} finally {
						if (parallel) { await sem.acquire(); _holdingSem = true; }
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
					if (!phaseDef) {
						state.updateEntity(appendEntry, pipelineId, entityId, {
							status: "failed",
							error: `Phase "${currentBase}" not found in definition`,
						});
						updateStatus();
						return;
					}

					// Terminal state (or skipped)
					if (currentBase === "done") {
						state.updateEntity(appendEntry, pipelineId, entityId, { status: "completed" });
						updateStatus();
						return;
					}

					// ── skipIf evaluation ──
					if (phaseDef.skipIf) {
						const skipOutputDir = resolveOutputDir(def, entityId, extraVars, pipelineId) || "";
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
							// Register waiter BEFORE sending message (prevent race)
							const { promise: llmDecision, resolve: llmResolve, reject: llmReject } = Promise.withResolvers<string>();
							run.llmWaiters.set(entityId, { resolve: llmResolve, reject: llmReject, prompt: llmPrompt });

							// Persist waiting state before await
							if (pi.memory) {
								void pi.memory.save(`llm-waiter-${entityId}`, {
									pipelineId,
									entityId,
									prompt: llmPrompt,
									timestamp: new Date().toISOString(),
								});
							}

							pi.sendUserMessage(llmPrompt, { deliverAs: "followUp" });

							// Release semaphore while waiting for LLM
							if (parallel) { sem.release(); _holdingSem = false; }
							updateStatus();
							try {
								const decision = await llmDecision;

								const lid = routeResult.loopId || "__global__";
								const counters = { ...currentEntity.loopCounters };
								const newIter = currentEntity.iter + (routeResult.iter ? 1 : 0);
								if (routeResult.iter) {
									counters[lid] = (counters[lid] || 0) + 1;
									const maxLoop = def.maxIterationsPerLoop?.[lid] ?? def.maxIterations ?? DEFAULT_MAX_ITER;
									if (counters[lid] >= maxLoop) {
										state.updateEntity(appendEntry, pipelineId, entityId, {
											status: "failed",
											error: `Max iterations for ${lid} (${maxLoop}) reached`,
											loopCounters: counters,
										});
										updateStatus();
										return { handled: true, breakLoop: true };
									}
								}
								state.updateEntity(appendEntry, pipelineId, entityId, {
									phase: decision, status: "pending", retries: 0, iter: newIter, loopCounters: counters,
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
								const isRouteCond = !("type" in trans && trans.type === "conditional");
								const shouldIter = isRouteCond ? routeResult.iter : decision === "loop";
								const lid = routeResult.loopId || "__global__";
								const counters = { ...currentEntity.loopCounters };
								const newIter = currentEntity.iter + (shouldIter ? 1 : 0);
								if (shouldIter) {
									counters[lid] = (counters[lid] || 0) + 1;
									const maxLoop = def.maxIterationsPerLoop?.[lid] ?? def.maxIterations ?? DEFAULT_MAX_ITER;
									if (counters[lid] >= maxLoop) {
										state.updateEntity(appendEntry, pipelineId, entityId, {
											status: "failed",
											error: `Max iterations for ${lid} (${maxLoop}) reached`,
											loopCounters: counters,
										});
										updateStatus();
										return { handled: true, breakLoop: true };
									}
								}
								state.updateEntity(appendEntry, pipelineId, entityId, {
									phase: nextPhase, status: "pending", retries: 0, iter: newIter, loopCounters: counters,
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

						const logDir = resolveOutputDir(def, entityId, extraVars, pipelineId);
						_log(`  ▶ ${currentBase} [${phaseDef.agent}]${retries > 0 ? ` (retry ${retries})` : ""}`);

						const result = await executePhase(
							entityId, phaseDef, agent, taskPrompt, cwd,
							undefined, undefined,
							logDir ? path.join(logDir, `.agent-${currentBase}.log`) : undefined,
							retries,
							{ ...state.flattenVars(def.variables), ...extraVars, entity: entityId },
							pi.logger,
						);

						// Structured log
						if (pi.logger) {
							if (result.exitCode !== 0 || result.error) {
								pi.logger.error(`Phase ${currentBase} failed for ${entityId}`, { error: result.error, exitCode: result.exitCode });
							} else {
								pi.logger.info(`Phase ${currentBase} completed for ${entityId}`, { outputLen: result.output.length });
							}
						}

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
								} catch { /* non-critical */ }
							}
						}

						// Auto-version declared output files
						if (phaseDef.versionOutputs?.length) {
							const outDir = resolveOutputDir(def, entityId, extraVars, pipelineId);
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
							const outputDir = resolveOutputDir(def, entityId, extraVars, pipelineId) || "";
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

						// Build PhaseSummary from agent output (word-boundary matching)
						if (result.output) {
							let summaryVerdict: "PASS" | "FAIL" | "UNCLEAR" = "UNCLEAR";
							// Match VERDICT: PASS / DECISION: PASS etc. with word boundaries
							if (/\b(?:VERDICT|DECISION|RESULT|STATUS)\s*:\s*PASS\b/i.test(result.output)) {
								summaryVerdict = "PASS";
							} else if (/\b(?:VERDICT|DECISION|RESULT|STATUS)\s*:\s*(?:FAIL|NOT\s*PASS)\b/i.test(result.output)) {
								summaryVerdict = "FAIL";
							}
							const findings: string[] = [];
							const phraseRe = /\b(VERDICT|DECISION|ERROR|WARN(?:ING)?)\b[:\s]*(\S[^\n]{0,120})/gi;
							let match: RegExpExecArray | null;
							while ((match = phraseRe.exec(result.output)) !== null) {
								findings.push(match[0].trim().slice(0, 120));
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
							lastExecutedPhase: currentBase,
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
		pi.logger?.info("Pipeline completed", { pipelineId, name: def.name, success: failed === 0 });
		return {
			success: failed === 0,
			summary: `Pipeline complete. ${entities.length - failed}/${entities.length} succeeded.\n\n${summary}`,
		};
	}

	// ═══════════════════════════════════════════════════════════
	// Command: /pipeline run <name> — BLOCKING EXECUTION
	// ═══════════════════════════════════════════════════════════
	pi.registerCommand("pipeline", {
		description: "Pipeline control: run <name> | validate <name> | cancel <id> | stop <id> | status | list",
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

			// ── /pipeline validate <name> ──
			if (sub === "validate" && parts[1]) {
				const pipelineName = parts[1];
				const def = definitions.get(pipelineName);
				if (!def) {
					ctx.ui.notify(
						`Pipeline "${pipelineName}" not found. Use /pipeline list to see available.`,
						"error",
					);
					return;
				}
				const errors = validatePipelineDefinition(def);

				// Check agent existence (only user+project agents)
				const agents = discoverAgents(ctx.cwd, undefined);
				for (const phase of def.phases) {
					if (phase.agent && !agents.has(phase.agent)) {
						errors.push(`Phase "${phase.name}": agent "${phase.agent}" not found`);
					}
				}
				if (errors.length === 0) {
					ctx.ui.notify(
						`✅ Pipeline "${pipelineName}" is valid. ${def.phases.length} phases: ${def.phases.map((p) => p.name).join(" → ")}`,
						"info",
					);
				} else {
					ctx.ui.notify(
						`❌ Pipeline "${pipelineName}" has ${errors.length} error(s):\n${errors.map((e) => `  • ${e}`).join("\n")}`,
						"error",
					);
				}
				return;
			}

			// ── /pipeline graph <name> ──
			if (sub === "graph" && parts[1]) {
				const pipelineName = parts[1];
				const def = definitions.get(pipelineName);
				if (!def) {
					ctx.ui.notify(
						`Pipeline "${pipelineName}" not found.`,
						"error",
					);
					return;
				}
				const graph = generateGraph(def);
				ctx.ui.notify(graph, "info");
				return;
			}

			// ── /pipeline logs <id> [--entity <e>] [--phase <p>] [--tail <n>] ──
			if (sub === "logs" && parts[1]) {
				const pipelineId = parts[1];
				const record = state.getPipeline(pipelineId);
				if (!record) {
					ctx.ui.notify(`Pipeline "${pipelineId}" not found.`, "error");
					return;
				}
				let entityFilter: string | null = null;
				let phaseFilter: string | null = null;
				let tailLines = 50;
				for (let i = 2; i < parts.length; i++) {
					if (parts[i] === "--entity" && parts[i + 1]) { entityFilter = parts[++i]; }
					else if (parts[i] === "--phase" && parts[i + 1]) { phaseFilter = parts[++i]; }
					else if (parts[i] === "--tail" && parts[i + 1]) { tailLines = parseInt(parts[++i], 10) || 50; }
				}

				const entities = entityFilter
					? [entityFilter]
					: Object.keys(record.entities);
				const phases = phaseFilter
					? [phaseFilter]
					: record.definition.phases.map(p => p.name);

				const baseVars = state.flattenVars(record.definition.variables);
				let outputBase = ".";
				if (record.definition.outputDir) {
					outputBase = record.definition.outputDir;
					for (const [k, v] of Object.entries(baseVars)) {
						outputBase = outputBase.replace(new RegExp(`\\{${k}\\}`, "g"), v || "");
					}
				}

				const output: string[] = [];
				for (const entityId of entities) {
					let entityDir = outputBase.replace(/\{entity\}/g, entityId).replace(/\{pipelineId\}/g, pipelineId);
					entityDir = entityDir.replace(/\/+/g, "/").replace(/\/$/, "");
					const ent = record.entities[entityId];
					const icon = ent?.status === "completed" ? "✅" : ent?.status === "failed" ? "❌" : ent?.status === "running" ? "▶" : "⏳";
					output.push(`\n## ${icon} ${entityId}`);

					for (const phaseName of phases) {
						const logPath = path.join(entityDir, `.agent-${phaseName}.log`);
						try {
							const content = fs.readFileSync(logPath, "utf-8");
							const lines = content.split("\n");
							const tail = tailLines > 0 ? lines.slice(-tailLines) : lines;
							output.push(`\n### ${phaseName} (${logPath})`);
							output.push(tail.join("\n"));
						} catch {
							output.push(`\n### ${phaseName} — no log file`);
						}
					}
				}
				ctx.ui.notify(output.join("\n"), "info");
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
						// Real-time widget below editor
						const lines = msg.split("\n");
						if (typeof ctx.ui.setWidget === "function") {
							ctx.ui.setWidget(lines, { placement: "belowEditor" });
						} else {
							ctx.ui.setStatus("pipeline", lines[0]?.slice(-100) ?? "");
						}
					},
					undefined,
				);

				// Clear widget on completion
				if (typeof ctx.ui.setWidget === "function") {
					ctx.ui.setWidget([], { placement: "belowEditor" });
				}
				ctx.ui.notify(result.summary, result.success ? "info" : "warning");
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
		parameters: pi.typebox.Type.Object({
			pipelineId: pi.typebox.Type.String({ description: "Pipeline ID" }),
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
		parameters: pi.typebox.Type.Object({
			pipelineId: pi.typebox.Type.Optional(pi.typebox.Type.String({ description: "Pipeline ID" })),
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
		parameters: pi.typebox.Type.Object({
			pipelineId: pi.typebox.Type.String({ description: "Pipeline ID" }),
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
