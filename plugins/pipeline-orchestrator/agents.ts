/**
 * Pipeline Orchestrator — agent discovery
 *
 * Adapted from pi's subagent extension. Discovers agent `.md` files from three
 * tiers, highest priority last (later tiers override same-named agents):
 *
 *   1. User level    — $PI_CODING_AGENT_DIR/agents, ~/.omp/agent/agents, ~/.pi/agent/agents
 *   2. Project level — .omp/agents, .pi/agents (cwd)
 *   3. Skill level   — {skillDir}/agents  (highest priority)
 *
 * omp (oh-my-pi) is the current runtime target; `.pi` paths are kept as
 * legacy compatibility for the original pi setup.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project" | "skill";
	filePath: string;
}

/**
 * Parse YAML frontmatter from Markdown.
 * Returns { frontmatter, body } where body is content after --- delimiters.
 */
function parseFrontmatter(content: string): {
	frontmatter: Record<string, string>;
	body: string;
} {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {}, body: content };

	const lines = match[1].split("\n");
	const frontmatter: Record<string, string> = {};
	let currentKey = "";

	for (const line of lines) {
		const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
		if (kv) {
			currentKey = kv[1];
			frontmatter[currentKey] = kv[2].trim();
		} else if (currentKey && line.startsWith("  ")) {
			frontmatter[currentKey] += `\n${line.trim()}`;
		}
	}

	return { frontmatter, body: match[2].trim() };
}

function loadAgentsFromDir(
	dir: string,
	source: "user" | "project" | "skill",
): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools?.length ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}
	return agents;
}

function getHomeDir(): string {
	return process.env.HOME || process.env.USERPROFILE || "~";
}

/** Candidate user-level agent directories, legacy .pi first, omp last (last wins). */
function userAgentDirs(): string[] {
	const home = getHomeDir();
	const dirs = [
		path.join(home, ".pi", "agent", "agents"),
		path.join(home, ".omp", "agent", "agents"),
	];
	// omp/pi allow relocating the agent dir at runtime; the override wins.
	const override = process.env.PI_CODING_AGENT_DIR;
	if (override) dirs.push(path.join(override, "agents"));
	return [...new Set(dirs)];
}

/** Candidate project-level agent directories, legacy .pi first, omp last (last wins). */
function projectAgentDirs(cwd: string): string[] {
	return [path.join(cwd, ".pi", "agents"), path.join(cwd, ".omp", "agents")];
}

export function discoverAgents(
	cwd: string,
	skillDir?: string,
): Map<string, AgentConfig> {
	const map = new Map<string, AgentConfig>();

	// 1. User-level agents
	for (const dir of userAgentDirs()) {
		for (const a of loadAgentsFromDir(dir, "user")) {
			map.set(a.name, a);
		}
	}

	// 2. Project-level agents (override user agents of same name)
	for (const dir of projectAgentDirs(cwd)) {
		for (const a of loadAgentsFromDir(dir, "project")) {
			map.set(a.name, a);
		}
	}

	// 3. Skill-level agents (highest priority — override both)
	if (skillDir) {
		const skillAgentsDir = path.join(skillDir, "agents");
		for (const a of loadAgentsFromDir(skillAgentsDir, "skill")) {
			map.set(a.name, a);
		}
	}

	return map;
}

/** Resolve an agent file path to its name (for Lookup) */
export function resolveAgentName(filePath: string): string {
	if (!fs.existsSync(filePath)) return "";
	const content = fs.readFileSync(filePath, "utf-8");
	const { frontmatter } = parseFrontmatter(content);
	return frontmatter.name || "";
}
