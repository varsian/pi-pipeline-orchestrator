/**
 * Pipeline Orchestrator — agent discovery
 *
 * Adapted from pi's subagent extension.
 * Discovers agent .md files from:
 *   1. ~/.pi/agent/agents/*.md  (user-level)
 *   2. .pi/agents/*.md           (project-level)
 *   3. Skill directory agents/   (skill-level, for card-generator etc.)
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

function getAgentDir(): string {
	const home = process.env.HOME || process.env.USERPROFILE || "~";
	return path.join(home, ".pi", "agent");
}

export function discoverAgents(
	cwd: string,
	skillDir?: string,
): Map<string, AgentConfig> {
	const map = new Map<string, AgentConfig>();

	// 1. User-level agents
	const userDir = path.join(getAgentDir(), "agents");
	for (const a of loadAgentsFromDir(userDir, "user")) {
		map.set(a.name, a);
	}

	// 2. Project-level agents
	const projectDir = path.join(cwd, ".pi", "agents");
	for (const a of loadAgentsFromDir(projectDir, "project")) {
		// Project agents override user agents of same name
		map.set(a.name, a);
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
