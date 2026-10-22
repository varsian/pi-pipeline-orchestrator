# Security Policy

## Supported versions

| Version | Supported |
|:--|:--|
| 2.x (current `main`) | ✅ security fixes |
| 1.x (pi-era engine, pre-omp port) | ❌ no longer maintained |

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private
vulnerability reporting instead:

1. Go to <https://github.com/varsian/pi-pipeline-orchestrator/security/advisories/new>.
2. Describe the issue, affected version/commit, and a minimal reproduction.
3. If private reporting is unavailable, open a regular issue that only says you have a
   security report and asks for a private channel — do not include exploit details.

This is a single-maintainer, early-stage project: best effort response, typically within a
week. Please give reasonable time to ship a fix before public disclosure.

## Trust model — a pipeline definition is executable code

Pipeline Orchestrator runs inside the coding agent process **with the same OS permissions
as the agent**, and it executes user-supplied configuration. Treat pipeline JSON and agent
Markdown files like shell scripts: only run pipelines you wrote or reviewed.

What a pipeline can do, by design:

| Surface | Execution |
|:--|:--|
| `phases[].validate` | `bash -c "<command>"` after the phase, in the pipeline's `cwd` |
| `phases[].skipIf.bash` | `bash -c "<command>"` before the phase |
| `phases[].hooks.before` / `.after` | `bash -c "<command>"` around the agent call (30s timeout) |
| `route.if.bash` | `bash -c "<command>"` while evaluating routes |
| sub-agents | spawned through the omp/pi `createAgentSession` SDK with whatever tools the agent definition grants (`read`, `write`, `bash`, …) |
| extension code | loaded in-process by omp/pi, so it can read session state, files and credentials accessible to the agent |

Consequences:

- **Do not load untrusted pipelines or agent files.** Cloning a random repo and pointing
  the plugin at its `.omp/pipelines/` is equivalent to running its shell scripts.
- Template variables are not a sandbox. `{work_dir}`, `{entity}` and friends are
  substituted into commands before `bash -c`; a malicious value can alter the command.
- Agent output and logs can contain secrets from your environment (for example if an agent
  runs `env`). Logs are written under the pipeline's `outputDir`; protect that directory
  accordingly and add it to `.gitignore`.
- The engine runs sub-agents in-process. A sub-agent's tool use is limited by the tools
  and permissions you grant it — not by the pipeline engine.

## Data collection

This repository contains **no telemetry and no network calls of its own**. Everything the
plugin executes is local (`bash`, filesystem, and the agent SDK). Agent sessions talk to
the model providers you configured, via omp/pi — review their data handling separately.

## Security-relevant hardening in this repo

- `.gitignore` excludes local runtime state (`.omp/`, `.pi/agents/`, `.pi/pipelines/`,
  `evidence/`, `_research/`, logs, archives).
- CI (`.github/workflows/ci.yml`) runs an offline check that fails on committed secrets,
  personal absolute paths, dead relative links, and inconsistent package metadata.
- The engine validates pipeline definitions before loading them: unknown route targets,
  malformed templates, unguarded cycles, and deprecated `conditional` transitions are
  rejected.
- State is persisted through the agent's session entries (and `memory` when configured),
  not through a network service.

## Out of scope

Vulnerabilities in omp/pi themselves, in the model providers, or in agents/pipelines you
install from third parties are out of scope here — report those upstream.
