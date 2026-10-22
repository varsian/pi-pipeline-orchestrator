# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-10-22

First tagged release. The 2.x engine replaces the v1 "spawn a `pi` subprocess and parse
its JSON stream" design with in-process agent sessions from the omp (oh-my-pi) SDK.
Because v1 was never tagged, this release note also covers the engine work that landed
between the initial public commit and today.

### Added

- Route-table transitions: AND-combined `exitCode`, `validatePassed`, `outputContains`,
  `outputRegex` (+ `captureOp` numeric compare), `fileExists`, `fileMinSize`,
  `fileMaxSize`, `bash`, and fallback conditions.
- Per-loop iteration counters (`loopId`, `loopCounters`, `maxIterationsPerLoop`) so
  nested loops no longer share a single counter.
- `PhaseSummary` extraction from the `yield` tool (`verdict`, `summary`, `keyFindings`)
  with text fallback, exposed to later phases as `{lastPhaseSummary.verdict}` /
  `{lastPhaseSummary.keyFindings}`.
- Phase hooks (`hooks.before` / `hooks.after`), `entityDependencies`, output versioning,
  conditional skips, and entity concurrency via a semaphore.
- `/pipeline validate`, `/pipeline graph` (Mermaid), and `/pipeline logs` subcommands.
- `SECURITY.md` documenting that a pipeline definition is executable configuration.
- Minimal CI: TypeScript typecheck, offline repository checks (JSON, links, metadata,
  secrets) and pinned actions.
- `scripts/check-repo.mjs`, `tsconfig.json`, `CHANGELOG.md`, and release notes.

### Changed

- Runtime target is **omp (oh-my-pi)**, the actively developed fork of Pi. Legacy
  `pi.extensions` manifests and `.pi/` paths are kept for compatibility; the plugin
  manifest declares both.
- Agent discovery now reads `.omp/agents` (project) and `~/.omp/agent/agents` (user),
  with `.omp` taking precedence over legacy `.pi` paths and `$PI_CODING_AGENT_DIR`
  honored. Skill-level agents remain highest priority.
- Node.js requirement is now **>= 22** (the engine uses `Promise.withResolvers`).
- Package metadata, READMEs, and the plugin reference were rewritten to match the actual
  runtime (in-process `createAgentSession`, omp paths) and to drop dead internal links.

### Fixed

- `generateGraph` contained an invalid string literal (unescaped quotes in the
  `__LLM__` / `done` labels); the extension could not be parsed at all.
- `executePhase` was called with an undefined `taskPrompt`, so every agent phase would
  throw a `ReferenceError`.
- Legacy `conditional` transitions crashed on an undefined `nextPhase` after a
  pass/loop decision.
- The definition validator rejected every pipeline containing a loop, even documented
  loops with `iter: true`. It now only rejects cycles with no `iter` edge (unguarded).
- Removed dead `_research/...` links from both READMEs.

### Removed

- Dead links to `_research/claude-dynamic-workflow/report.md` (the directory is
  gitignored and not part of the repository).

## [1.0.0] - 2026-06-04

Initial public release of the pi-targeted engine: JSON pipeline definitions executed by
spawning `pi` subprocesses, agent discovery from `.pi/agents`, session-entry state
persistence, and the `pipeline-setup` skill.
