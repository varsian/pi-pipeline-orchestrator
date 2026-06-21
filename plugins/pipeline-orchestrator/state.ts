/**
 * Pipeline Orchestrator — state engine v4 (omp)
 *
 * Persists pipeline state via pi.appendEntry() with memory:// backup.
 * Supports route-table transitions and context injection.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	EntityState,
	PipelineDefinition,
	PipelineRecord,
	Route,
	RouteCondition,
} from "./types.js";

const ENTRY_TYPE = "pipeline-state";

const store = new Map<string, PipelineRecord>();

/** Extract a string value from a pipeline variable (handles both plain string and {description, default} object) */
export function resolveVarValue(v: string | { description?: string; default?: string } | undefined): string {
	if (typeof v === "string") return v;
	if (v && typeof v === "object") return v.default ?? "";
	return "";
}

/** Convert a variables record to a flat {key: string} map for substitution */
export function flattenVars(
	vars: Record<string, string | { description?: string; default?: string }>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(vars)) {
		out[k] = resolveVarValue(v);
	}
	return out;
}

/** Compute outputDir from pipeline definition + entity */
function computeOutputDir(
	record: PipelineRecord,
	entityId: string,
	extraVars: Record<string, string>,
): string {
	if (!record.definition.outputDir) return "";
	let dir = record.definition.outputDir;
	const vars = { ...flattenVars(record.definition.variables), ...extraVars, entity: entityId };
	for (const [k, v] of Object.entries(vars)) {
		dir = dir.replace(new RegExp(`{${k}}`, "g"), v);
	}
	return dir;
}

/** Substitute variables in a string template */
function substituteVars(template: string, vars: Record<string, string>): string {
	let result = template;
	for (const [k, v] of Object.entries(vars)) {
		result = result.replace(new RegExp(`\\{${k}\\}`, "g"), v);
	}
	return result;
}

export function restoreFromEntries(
	entries: Array<{ type: string; customType?: string; data?: unknown }>,
) {
	store.clear();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
			const record = entry.data as PipelineRecord;
			if (record?.pipelineId) {
				store.set(record.pipelineId, record);
			}
		}
	}
}

/** Reset entities stuck in "running" status (crashed mid-phase) to "pending" for resume. */
export function resetStrandedEntities(): void {
	for (const record of store.values()) {
		for (const entity of Object.values(record.entities)) {
			if (entity.status === "running") {
				entity.status = "pending";
				entity.updatedAt = new Date().toISOString();
				record.updatedAt = entity.updatedAt!;
			}
		}
	}
}

export function getPipeline(pipelineId: string): PipelineRecord | undefined {
	return store.get(pipelineId);
}

export function getAllPipelines(): PipelineRecord[] {
	return Array.from(store.values());
}

/** Create a new pipeline run with full definition */
export function createPipeline(
	appendEntry: (type: string, data: unknown) => void,
	pipelineId: string,
	definition: PipelineDefinition,
	entityIds: string[],
	onPersist?: (record: PipelineRecord) => void,
): PipelineRecord {
	const now = new Date().toISOString();
	const entities: Record<string, EntityState> = {};
	for (const id of entityIds) {
		entities[id] = {
			entityId: id,
			phase: definition.phases[0]?.name ?? "pending",
			status: "pending",
			iter: 1,
			loopCounters: {},
			retries: 0,
			phaseSummaries: {},
			updatedAt: now,
		};
	}
	const record: PipelineRecord = {
		pipelineId,
		definition,
		entities,
		startedAt: now,
		updatedAt: now,
	};
	store.set(pipelineId, record);
	appendEntry(ENTRY_TYPE, record);
	onPersist?.(record);
	return record;
}

export function updateEntity(
	appendEntry: (type: string, data: unknown) => void,
	pipelineId: string,
	entityId: string,
	patch: Partial<EntityState>,
	onPersist?: (record: PipelineRecord) => void,
): EntityState | null {
	const record = store.get(pipelineId);
	if (!record) return null;
	const current = record.entities[entityId];
	if (!current) return null;

	const updated: EntityState = {
		...current,
		...patch,
		updatedAt: new Date().toISOString(),
	};
	record.entities[entityId] = updated;
	record.updatedAt = updated.updatedAt!;
	appendEntry(ENTRY_TYPE, record);
	onPersist?.(record);
	return updated;
}

export function getActiveEntities(pipelineId: string): EntityState[] {
	const record = store.get(pipelineId);
	if (!record) return [];
	return Object.values(record.entities).filter(
		(e) => e.status !== "completed" && e.status !== "failed",
	);
}

/** Get the phase definition for a given phase name */
export function getPhaseDef(pipelineId: string, phaseName: string) {
	const record = store.get(pipelineId);
	if (!record) return null;
	const base = phaseName.split("|")[0];
	return record.definition.phases.find((p) => p.name === base) ?? null;
}

/** Find the most recent incomplete pipeline by definition name (for resume) */
export function findIncompleteByName(
	pipelineName: string,
): PipelineRecord | undefined {
	let best: PipelineRecord | undefined;
	for (const record of store.values()) {
		if (record.definition.name !== pipelineName) continue;
		const hasPending = Object.values(record.entities).some(
			(e) => e.status !== "completed" && e.status !== "failed",
		);
		if (!hasPending) continue;
		if (!best || record.updatedAt > best.updatedAt) best = record;
	}
	return best;
}

/** Determine next phase by evaluating route table conditions */
export function resolveRouteNext(
	pipelineId: string,
	entityId: string,
	context: {
		exitCode: number;
		validatePassed: boolean;
		agentOutput: string;
		cwd: string;
		extraVars: Record<string, string>;
	},
): { next: string | null; iter: boolean; prompt?: string; loopId?: string } {
	const record = store.get(pipelineId);
	if (!record) return { next: null, iter: false };

	const entity = record.entities[entityId];
	if (!entity) return { next: null, iter: false };

	const base = entity.phase.split("|")[0];
	const phases = record.definition.phases;
	const idx = phases.findIndex((p) => p.name === base);
	if (idx === -1) return { next: null, iter: false };

	const phase = phases[idx];
	const transition = phase.transition;

	// ── Backward compat: old transition types ──
	if ("type" in transition && transition.type === "auto") {
		return {
			next: idx < phases.length - 1 ? phases[idx + 1].name : "done",
			iter: false,
		};
	}
	if ("type" in transition && transition.type === "llm") {
		return { next: "__LLM__", iter: false, prompt: transition.prompt };
	}
	if ("type" in transition && transition.type === "conditional") {
		return { next: "__COND__", iter: false };
	}
	if ("type" in transition && transition.type === "manual") {
		return { next: "__MANUAL__", iter: false };
	}

	// ── Route table evaluation ──
	if ("routes" in transition && transition.routes) {
		for (const route of transition.routes) {
			if (evaluateRouteCondition(route, context, record, entityId)) {
				const next = route.next;
				// Resolve special markers
				if (next === "__NEXT__") {
					const linearNext = idx < phases.length - 1 ? phases[idx + 1].name : "done";
					return { next: linearNext, iter: !!route.iter, loopId: route.loopId };
				}
				if (next === "__LLM__") {
					return { next: "__LLM__", iter: !!route.iter, prompt: route.prompt, loopId: route.loopId };
				}
				if (next === "__COND__") {
					return { next: "__COND__", iter: !!route.iter, prompt: route.prompt, loopId: route.loopId };
				}
				if (next === "__MANUAL__") {
					return { next: "__MANUAL__", iter: false, prompt: route.prompt, loopId: route.loopId };
				}
				return { next, iter: !!route.iter, loopId: route.loopId };
			}
		}
		// No route matched → fallback to linear
		const linearNext = idx < phases.length - 1 ? phases[idx + 1].name : "done";
		return { next: linearNext, iter: false };
	}

	// Fallback: linear advance
	const next = idx < phases.length - 1 ? phases[idx + 1].name : "done";
	return { next: next === base ? "done" : next, iter: false };
}

/** Evaluate a single route condition against the current context */
function evaluateRouteCondition(
	route: Route,
	ctx: {
		exitCode: number;
		validatePassed: boolean;
		agentOutput: string;
		cwd: string;
		extraVars: Record<string, string>;
	},
	record: PipelineRecord,
	entityId: string,
): boolean {
	if (route.if === true) return true;

	const c = route.if as RouteCondition;

	if (c.exitCode !== undefined && c.exitCode !== ctx.exitCode) return false;

	if (c.validatePassed !== undefined && c.validatePassed !== ctx.validatePassed)
		return false;

	if (c.outputContains !== undefined && !ctx.agentOutput.includes(c.outputContains))
		return false;

	if (c.outputRegex) {
		const re = new RegExp(c.outputRegex, "m");
		const match = ctx.agentOutput.match(re);
		if (!match) return false;
		if (c.captureOp && match[1]) {
			const num = Number(match[1]);
			if (Number.isNaN(num)) return false;
			const { op, value } = c.captureOp;
			if (op === "eq" && num !== value) return false;
			if (op === "neq" && num === value) return false;
			if (op === "gt" && num <= value) return false;
			if (op === "gte" && num < value) return false;
			if (op === "lt" && num >= value) return false;
			if (op === "lte" && num > value) return false;
		}
	}

	if (c.fileExists) {
		const vars = { ...flattenVars(record.definition.variables), ...ctx.extraVars, entity: entityId, outputDir: computeOutputDir(record, entityId, ctx.extraVars) };
		let fp = substituteVars(c.fileExists, vars);
		try {
			if (!fs.existsSync(fp)) return false;
		} catch {
			return false;
		}
	}

	if (c.fileMinSize) {
		const vars = { ...flattenVars(record.definition.variables), ...ctx.extraVars, entity: entityId, outputDir: computeOutputDir(record, entityId, ctx.extraVars) };
		let fp = substituteVars(c.fileMinSize.path, vars);
		try {
			const stat = fs.statSync(fp);
			if (stat.size < c.fileMinSize.bytes) return false;
		} catch {
			return false;
		}
	}

	if (c.fileMaxSize) {
		const vars = { ...flattenVars(record.definition.variables), ...ctx.extraVars, entity: entityId, outputDir: computeOutputDir(record, entityId, ctx.extraVars) };
		let fp = substituteVars(c.fileMaxSize.path, vars);
		try {
			const stat = fs.statSync(fp);
			if (stat.size > c.fileMaxSize.bytes) return false;
		} catch {
			return false;
		}
	}

	if (c.bash) {
		const vars = { ...flattenVars(record.definition.variables), ...ctx.extraVars, entity: entityId, outputDir: computeOutputDir(record, entityId, ctx.extraVars) };
		let cmd = substituteVars(c.bash, vars);
		try {
			const r = spawnSync("bash", ["-c", cmd], { cwd: ctx.cwd, timeout: 30000 });
			if (r.status !== 0) return false;
		} catch {
			return false;
		}
	}

	if (c.default === true) return true;

	return true;
}

/** Auto-version output files: agent writes foo.md → pipeline renames to {iter}-foo.md */
export function versionOutputFiles(
	phaseDef: { versionOutputs?: string[] },
	iter: number,
	outputDir: string,
): void {
	if (!phaseDef.versionOutputs?.length) return;
	for (const filename of phaseDef.versionOutputs) {
		const src = path.join(outputDir, filename);
		try {
			if (!fs.existsSync(src)) continue;
			const dest = path.join(outputDir, `${iter}-${filename}`);
			if (fs.existsSync(dest)) fs.unlinkSync(dest);
			fs.renameSync(src, dest);
		} catch {
			/* non-critical */
		}
	}
}

/** Evaluate skipIf condition for an entity */
export function evaluateSkipIf(
	phaseDef: { skipIf?: { bash?: string; fileExists?: string; fileNotExists?: string } },
	entityId: string,
	extraVars: Record<string, string>,
	pipelineVars: Record<string, string>,
	outputDir: string,
	cwd: string,
): boolean {
	const s = phaseDef.skipIf;
	if (!s) return false;

	const vars = { ...pipelineVars, ...extraVars, entity: entityId, outputDir };

	if (s.fileExists) {
		try {
			if (fs.existsSync(substituteVars(s.fileExists, vars))) return true;
		} catch {
			return false; // can't verify → don't skip
		}
	}

	if (s.fileNotExists) {
		try {
			if (!fs.existsSync(substituteVars(s.fileNotExists, vars))) return true;
		} catch {
			return true; // can't access → assume absent → skip
		}
	}

	if (s.bash) {
		try {
			const r = spawnSync("bash", ["-c", substituteVars(s.bash, vars)], { cwd, timeout: 30000 });
			if (r.status === 0) return true;
		} catch {
			return true;
		}
	}

	return false;
}

/** Substitute variables in a task template */
export function renderTaskTemplate(
	pipelineId: string,
	entityId: string,
	extraVars?: Record<string, string>,
): string {
	const record = store.get(pipelineId);
	if (!record) return "";

	const entity = record.entities[entityId];
	if (!entity) return "";

	const phaseName = entity.phase.split("|")[0];
	const phase = record.definition.phases.find((p) => p.name === phaseName);
	if (!phase) return "";

	let template = phase.taskTemplate.template;
	const iter = entity.iter ?? 0;

	// Resolve output directory
	let outputDir = "";
	if (record.definition.outputDir) {
		const tmpVars: Record<string, string> = {
			...flattenVars(record.definition.variables),
			...extraVars,
			entity: entityId,
			pipelineId,
		};
		outputDir = substituteVars(record.definition.outputDir, tmpVars);
	}

	const vars: Record<string, string> = {
		...flattenVars(record.definition.variables),
		...phase.taskTemplate.variables,
		...extraVars,
		entity: entityId,
		pipelineId,
		iter: String(iter),
		iterPrev: String(iter - 1),
		lastOutput: entity.lastOutput ?? "",
	};

	// Resolve {output:phaseName} patterns
	template = template.replace(/\{output:(\w+)\}/g, (_match, pn: string) => {
		if (!outputDir) return `{output:${pn}}`;
		return `${outputDir}/.agent-${pn}.log`;
	});
	template = template.replace(/\{output\}/g, () => {
		if (!outputDir) return "{output}";
		return `${outputDir}/.agent-${phaseName}.log`;
	});
	template = template.replace(/\{outputDir\}/g, outputDir || "{outputDir}");
	template = template.replace(/\{outputDirFiles\}/g, () => {
		if (!outputDir) return "{outputDirFiles}";
		try {
			const files = fs.readdirSync(outputDir);
			return files.length > 0 ? files.join("\n") : "(empty directory)";
		} catch {
			return "(cannot read directory)";
		}
	});

	// {lastPhaseSummary.*} — from most recently executed phase (execution order, not definition order)
	const lastExecuted = entity.lastExecutedPhase;
	const lastSummary = lastExecuted ? entity.phaseSummaries?.[lastExecuted] : null;
	template = template.replace(/\{lastPhaseSummary\.verdict\}/g, lastSummary?.verdict ?? "UNCLEAR");
	template = template.replace(/\{lastPhaseSummary\.keyFindings\}/g, lastSummary?.keyFindings?.join("\n") ?? "");

	template = substituteVars(template, vars);

	// ── Output contract: every agent MUST produce structured yield output ──
	template +=
		"\n\n---\n## COMPLETION\n" +
		"When finished, you MUST call `yield` exactly once with:\n" +
		"  yield({ result: { data: { verdict: \"PASS\"|\"FAIL\"|\"UNCLEAR\", summary: \"...\", keyFindings: [...] } } })\n" +
		"This is your only way to return a result. You NEVER put JSON in plain text.\n" +
		"Giving up is a last resort. If truly blocked, call yield with result.error describing the blocker.";
	const prevPhase = entity.lastExecutedPhase;
	if (prevPhase) {
		const summary = entity.phaseSummaries?.[prevPhase];
		let context = `\n\n---\n## PREVIOUS PHASE: ${prevPhase}`;
		if (summary) {
			context += `\nVerdict: ${summary.verdict}`;
			if (summary.keyFindings.length > 0) {
				context += `\nFindings:\n${summary.keyFindings.map(f => `- ${f}`).join('\n')}`;
			}
			const output = entity.phaseOutputs?.[prevPhase] ?? entity.lastOutput ?? "";
			if (output) {
				const truncated = output.length > 2000 ? output.slice(0, 2000) + "\n…[truncated]" : output;
				context += `\nOutput:\n${truncated}`;
			}
		} else {
			const output = entity.lastOutput ?? "";
			if (output) {
				const truncated = output.length > 2000 ? output.slice(0, 2000) + "\n…[truncated]" : output;
				context += `\n${truncated}`;
			}
		}
		context += "\n---\n";
		template = context + template;
	}

	return template;
}
export function summarizePipeline(pipelineId: string): string {
	const record = store.get(pipelineId);
	if (!record) return "No pipeline found.";

	const lines: string[] = [
		`Pipeline: ${pipelineId} (${record.definition.name})`,
		`Entity type: ${record.definition.entityType}`,
		`Phases: ${record.definition.phases.map((p) => p.name).join(" → ")}`,
		`Started: ${record.startedAt}`,
		"",
	];

	const ents = Object.values(record.entities);

	for (const e of ents) {
		const icon = e.status === "completed" ? "✅" : e.status === "failed" ? "❌" : e.status === "skipped" ? "⏭️" : e.status === "running" ? "▶️" : "⏳";
		let entityLine = `  ${icon} ${e.entityId}  ${e.phase}`;
		if (e.loopCounters && Object.keys(e.loopCounters).length > 0) {
			const max = record.definition.maxIterationsPerLoop ?? {};
			const loopParts = Object.entries(e.loopCounters).map(([lid, count]) => {
				const limit = max[lid] ?? record.definition.maxIterations ?? 5;
				return `${lid}: ${count}/${limit}`;
			});
			entityLine += `  [${loopParts.join(", ")}]`;
		}
		if (e.error) entityLine += `  ⚠️ ${e.error.slice(0, 80)}`;
		lines.push(entityLine);
	}

	lines.push("");
	lines.push("Phase pass rates:");
	for (const phase of record.definition.phases) {
		const entered = ents.filter((e) => e.phaseSummaries?.[phase.name]);
		if (entered.length === 0) continue;
		const passed = entered.filter((e) => e.phaseSummaries?.[phase.name]?.verdict === "PASS");
		const pct = Math.round((passed.length / entered.length) * 100);
		const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
		lines.push(`  ${phase.name.padEnd(15)} ${bar} ${pct}% (${passed.length}/${entered.length})`);
	}

	return lines.join("\n");
}
