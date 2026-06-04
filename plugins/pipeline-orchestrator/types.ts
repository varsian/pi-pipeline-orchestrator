/**
 * Pipeline Orchestrator — types v3
 *
 * Route-table based transitions with condition evaluation.
 * Backward compatible with v2 auto/llm/conditional/manual types.
 */

// ── Route Table types ──

/** Condition object: all keys must match (AND) */
export interface RouteCondition {
	exitCode?: number;
	validatePassed?: boolean;
	outputContains?: string;
	outputRegex?: string;
	/** Numeric comparison on regex capture group */
	captureOp?: { op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte"; value: number };
	fileExists?: string;
	fileMinSize?: { path: string; bytes: number };
	fileMaxSize?: { path: string; bytes: number };
	bash?: string;
	/** Always match (fallback) */
	default?: true;
}

/** A single route: conditions → next phase */
export interface Route {
	if: RouteCondition | true;
	next: string;
	iter?: boolean;
	/** Loop identifier for per-loop iteration counting (defaults to "__global__") */
	loopId?: string;
	prompt?: string;  // for __LLM__ routes only
}

/** Unified transition: either old-style type or new route table */
export type TransitionRule =
	| { type: "auto" }
	| { type: "conditional"; field: string; pass: string; loop: string }
	| { type: "manual" }
	| { type: "llm"; prompt: string }
	| { routes: Route[] };

/** Task prompt template with variable substitution */
export interface TaskTemplate {
	template: string; // e.g. "审查 {study_dir}/cards/{entity}/all.txt"
	variables: Record<string, string>; // default values, can be overridden
}

export interface PhaseDefinition {
	/** Phase name (used as state value) */
	name: string;
	/** Human-readable label */
	label?: string;
	/** Agent name (discovered from agent directories) */
	agent: string;
	/** Task prompt template */
	taskTemplate: TaskTemplate;
	/** How to transition after this phase completes */
	transition: TransitionRule;
	/** Bash validation command (run after phase completes, exit 0 = pass). Can be a plain string or {bash: string}. */
	validate?: string | { bash: string };
	/** Max retries for agent failures (default 3) */
	maxRetries?: number;
	/** Phase timeout in minutes (default 30) */
	timeoutMinutes?: number;
	/** Override agent model (optional) */
	model?: string;
	/** Override agent tools (optional) */
	tools?: string;
	/** Phase description */
	description?: string;
	/** Entity-level skip condition (evaluated before agent spawn) */
	skipIf?: { bash?: string; fileExists?: string; fileNotExists?: string };
	/** Reason logged when entity is skipped */
	skipReason?: string;
	/** Output files to auto-version (agent writes fixed name, pipeline adds {iter}- prefix) */
	versionOutputs?: string[];
	/** Hooks executed before/after agent spawn (middleware) */
	hooks?: { before?: string; after?: string };
}

/** Entity auto-discovery config */
export interface EntityDiscoveryConfig {
	/** Directory pattern with {study_dir} variable, e.g. "{study_dir}/phy/questions/" */
	pattern: string;
	/** Entity names to exclude from discovery */
	exclude?: string[];
}

export interface PipelineDefinition {
	/** Pipeline name (e.g. "card-generator") */
	name: string;
	/** What kind of entities this pipeline operates on */
	entityType: string;
	/** Lifecycle mode: "oneshot" (single-use) or "iterative" (evolving pipeline) */
	lifecycle?: "oneshot" | "iterative";
	/** Shared variables for task templates (e.g. study_dir, skill_dir). May be plain string or {description, default} object. */
	variables: Record<string, string | { description?: string; default?: string }>;
	/** Ordered list of phases */
	phases: PhaseDefinition[];
	/** Max global fix iterations (default 5). For per-loop limits use maxIterationsPerLoop. */
	maxIterations?: number;
	/** Per-loop iteration limits keyed by loopId (e.g. { "research_loop": 5, "code_loop": 3 }) */
	maxIterationsPerLoop?: Record<string, number>;
	/** Entity dependency graph: key depends on all entities in value array */
	entityDependencies?: Record<string, string[]>;
	/** Auto-discovery config for entities (optional; without it, --entity is required) */
	entityDiscovery?: EntityDiscoveryConfig;
	/** Output directory template (e.g. "{study_dir}/cards/{entity}"). Used for log files and auto-versioning. */
	outputDir?: string;
	/** Max concurrent entities (default: 0 = unlimited). Phase execution within an entity remains serial. */
	concurrency?: number;
}

/** Structured summary extracted from agent output after each phase */
export interface PhaseSummary {
	verdict: "PASS" | "FAIL" | "UNCLEAR";
	keyFindings: string[];
}

/** Change manifest entry — one edit to pipeline.json tracked across iterations */
export interface ChangeEntry {
	target: string;
	before: unknown;
	after: unknown;
	why: string;
	verdict: "kept" | "reverted" | null;
}

export interface ChangeRound {
	round: number;
	timestamp: string;
	changes: ChangeEntry[];
}

export interface ChangeManifest {
	rounds: ChangeRound[];
}

/** Accumulated lesson from pipeline runs */
export interface Lesson {
	pattern: string;
	rootCause: string;
	fix: string;
	confirmedRuns: string[];
	regressionRuns: string[];
}

export interface MemoryStore {
	lessons: Lesson[];
}

/** Runtime state of a single entity going through the pipeline */
export interface EntityState {
	entityId: string;
	phase: string;
	status: "pending" | "running" | "completed" | "failed" | "skipped";
	iter: number;
	/** Per-loop iteration counters (loopId → count). Replaces global iter for multi-loop pipelines. */
	loopCounters: Record<string, number>;
	retries: number;
	error?: string;
	/** Last agent output text (for context injection on retry) */
	lastOutput?: string;
	/** Per-phase output texts keyed by phase name */
	phaseOutputs?: Record<string, string>;
	/** Per-phase structured summaries (phase name → summary) */
	phaseSummaries: Record<string, PhaseSummary>;
	updatedAt: string;
}

/** Persisted pipeline run record */
export interface PipelineRecord {
	pipelineId: string;
	definition: PipelineDefinition;
	entities: Record<string, EntityState>;
	startedAt: string;
	updatedAt: string;
}
