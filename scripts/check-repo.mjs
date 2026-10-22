#!/usr/bin/env node
/**
 * Offline repository consistency check (used by CI).
 *
 * Verifies, without network access and without installing anything:
 *   1. JSON files parse (package.json, package-lock.json, plugin package.json)
 *   2. Package metadata is consistent (name / version / engines / license)
 *   3. Extension manifest entries point at real files
 *   4. Required repository files exist
 *   5. Fenced JSON examples in the READMEs are valid JSON
 *   6. Every relative Markdown link resolves
 *   7. No secrets, personal absolute paths, private paths or non-noreply emails
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/check-repo.mjs";
const failures = [];
const fail = (msg) => failures.push(msg);

// ── collect tracked-ish files ────────────────────────────────────────────────
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}
const allFiles = walk(root);
const rel = (abs) => path.relative(root, abs).replaceAll("\\", "/");
const textExtensions = new Set([".md", ".json", ".jsonc", ".ts", ".mjs", ".js", ".yaml", ".yml", ".txt", ".gitignore", ".gitattributes", ".gitmessage"]);
const textFiles = allFiles.filter((abs) => {
  const r = rel(abs);
  if (r === SELF) return false;
  const ext = path.extname(abs);
  return textExtensions.has(ext) || path.basename(abs) === "LICENSE";
});

// ── 1. JSON files parse ──────────────────────────────────────────────────────
const jsonFiles = ["package.json", "package-lock.json", "plugins/pipeline-orchestrator/package.json"];
const parsed = {};
for (const r of jsonFiles) {
  try {
    parsed[r] = JSON.parse(fs.readFileSync(path.join(root, r), "utf8"));
  } catch (err) {
    fail(`${r}: invalid JSON (${err.message})`);
  }
}

// ── 2. metadata consistency ──────────────────────────────────────────────────
const pkg = parsed["package.json"];
const lock = parsed["package-lock.json"];
const pluginPkg = parsed["plugins/pipeline-orchestrator/package.json"];
const EXPECTED_NAME = "pi-pipeline-orchestrator";
const EXPECTED_LICENSE = "AGPL-3.0";
const MIN_NODE = 22;
if (pkg) {
  if (pkg.name !== EXPECTED_NAME) fail(`package.json: name should be ${EXPECTED_NAME}`);
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? "")) fail("package.json: version must be semver");
  if (pkg.license !== EXPECTED_LICENSE) fail(`package.json: license should be ${EXPECTED_LICENSE}`);
  const min = Number((pkg.engines?.node ?? "").replace(/[^\d]/g, "").slice(0, 2));
  if (!(min >= MIN_NODE)) fail(`package.json: engines.node should require >= ${MIN_NODE} (found ${pkg.engines?.node})`);
  if (pkg.private !== true) fail("package.json: set \"private\": true (repo is not published to npm)");
  if (!pkg.scripts?.typecheck) fail("package.json: missing typecheck script");
  if (!pkg.scripts?.check) fail("package.json: missing check script");
  if (!pkg.devDependencies?.typescript) fail("package.json: typescript must be a devDependency (typecheck script)");
}
if (pkg && lock) {
  if (lock.name !== pkg.name) fail(`package-lock.json: name ${lock.name} != package.json ${pkg.name}`);
  if (lock.version !== pkg.version) fail(`package-lock.json: version ${lock.version} != package.json ${pkg.version}`);
  if (lock.packages?.[""]?.name !== pkg.name) fail("package-lock.json: root package name mismatch (run npm install)");
}
if (pkg && pluginPkg) {
  if (pluginPkg.name !== "pipeline-orchestrator") fail("plugin package.json: name should be pipeline-orchestrator");
  if (pluginPkg.version !== pkg.version) fail(`plugin package.json: version ${pluginPkg.version} != project version ${pkg.version}`);
  if (!pluginPkg.description?.includes("omp")) fail("plugin package.json: description should mention the omp runtime");
}
const licenseText = fs.readFileSync(path.join(root, "LICENSE"), "utf8");
if (!licenseText.includes("GNU AFFERO GENERAL PUBLIC LICENSE")) fail("LICENSE: expected GNU AGPL v3 text");

// ── 3. extension manifest entries exist ─────────────────────────────────────
for (const key of ["omp", "pi"]) {
  const entries = pluginPkg?.[key]?.extensions;
  if (!Array.isArray(entries) || entries.length === 0) fail(`plugin package.json: missing ${key}.extensions manifest`);
  else for (const entry of entries) {
    const target = path.join(root, "plugins/pipeline-orchestrator", entry);
    if (!fs.existsSync(target)) fail(`plugin package.json: ${key}.extensions entry not found: ${entry}`);
  }
}

// ── 4. required files ───────────────────────────────────────────────────────
for (const r of [
  "README.md", "README_zh.md", "LICENSE", "SECURITY.md", "CHANGELOG.md",
  "tsconfig.json", "plugins/pipeline-orchestrator/index.ts", "plugins/pipeline-orchestrator/README.md",
  "skills/pipeline-setup/SKILL.md", "docs/pipeline-orchestrator-evolution-design.md",
  ".github/workflows/ci.yml",
]) {
  if (!fs.existsSync(path.join(root, r))) fail(`missing required file: ${r}`);
}

// ── 5. fenced JSON examples in READMEs parse ────────────────────────────────
for (const r of ["README.md", "README_zh.md"]) {
  if (!fs.existsSync(path.join(root, r))) continue;
  const text = fs.readFileSync(path.join(root, r), "utf8");
  const re = /```json[^\n]*\n([\s\S]*?)```/g;
  let match;
  let index = 0;
  while ((match = re.exec(text))) {
    index += 1;
    try {
      JSON.parse(match[1]);
    } catch (err) {
      fail(`${r}: fenced JSON block #${index} does not parse (${err.message})`);
    }
  }
}

// ── 6. relative markdown links resolve ──────────────────────────────────────
const mdFiles = allFiles.filter((abs) => abs.endsWith(".md"));
const linkRe = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
for (const abs of mdFiles) {
  const text = fs.readFileSync(abs, "utf8");
  for (const m of text.matchAll(linkRe)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/i.test(target)) continue;
    const clean = target.split("#")[0].split("?")[0];
    if (!clean) continue;
    const resolved = path.resolve(path.dirname(abs), decodeURIComponent(clean));
    if (!fs.existsSync(resolved)) fail(`${rel(abs)}: broken relative link -> ${target}`);
  }
}

// ── 7. secrets / personal data / private paths ──────────────────────────────
const secretPatterns = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["API key (sk-)", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{15,}/],
  ["assigned secret", /(api[_-]?key|apikey|secret|password|passwd|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][^"'\s]{8,}["']/i],
];
const personalPatterns = [
  ["Windows user path", /\b[A-Za-z]:[\\/]Users[\\/]/],
  ["macOS user path", /\/Users\/[A-Za-z0-9._-]+\//],
  ["Linux user path", /\/home\/[A-Za-z0-9._-]+\//],
  ["personal marker", new RegExp("\\b(" + ["Met" + "eor", "live" + "mind", "deep" + "seek", "d" + "sh"].join("|") + ")\\b", "i")],
];
const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
for (const abs of textFiles) {
  const text = fs.readFileSync(abs, "utf8");
  text.split("\n").forEach((line, i) => {
    for (const [label, re] of secretPatterns) {
      if (re.test(line)) fail(`${rel(abs)}:${i + 1}: possible ${label}`);
    }
    for (const [label, re] of personalPatterns) {
      if (re.test(line)) fail(`${rel(abs)}:${i + 1}: ${label} found`);
    }
    for (const email of line.match(emailRe) ?? []) {
      if (!email.endsWith("@users.noreply.github.com")) {
        fail(`${rel(abs)}:${i + 1}: unexpected email address ${email}`);
      }
    }
  });
}

// ── report ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`check-repo: ${failures.length} problem(s) found\n`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`check-repo: OK (${allFiles.length} files, ${mdFiles.length} markdown files, ${textFiles.length} scanned)`);
