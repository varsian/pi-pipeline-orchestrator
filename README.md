# Pipeline Orchestrator

**A declarative multi-agent pipeline engine for the pi coding-agent ecosystem.** Define multi-phase workflows as a JSON state machine — the engine discovers entities, runs sub-agents in parallel, retries failures, pauses at LLM decision points, and resumes after a restart.

[![CI](https://github.com/varsian/pi-pipeline-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/varsian/pi-pipeline-orchestrator/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](CHANGELOG.md)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](package.json)
[![Runs on omp](https://img.shields.io/badge/runs%20on-omp%20%28oh--my--pi%29-5B8DEF)](https://github.com/can1357/oh-my-pi)

> [中文文档](README_zh.md)

**Runtime:** this engine targets [omp](https://github.com/can1357/oh-my-pi) (`@oh-my-pi/pi-coding-agent`), the actively developed fork of [Pi](https://github.com/badlogic/pi-mono), and runs sub-agents in-process through its agent SDK. Legacy `pi.extensions` manifests and `.pi/` config paths are still honored; using it on upstream Pi requires swapping the SDK import (see [the plugin README](plugins/pipeline-orchestrator/README.md#runtime-and-compatibility)).

**Status:** v2.0.0, early stage. A pipeline definition is executable configuration — it can run `bash` validation commands and hooks — so only run pipelines you trust. See [SECURITY.md](SECURITY.md).

---

## Why this exists

A single agent conversation is fine for "edit this file". It breaks down when you need to process 50 inputs through generate → review → classify passes, pause for a human call in the middle, resume after a crash, and prove what happened.

Pipeline Orchestrator moves that logic out of the prompt and into a **version-controlled JSON state machine**. You review and diff the workflow; the engine schedules the sub-agents.

---

## Quick start

### 1. Install the extension

```bash
git clone https://github.com/varsian/pi-pipeline-orchestrator
cd pi-pipeline-orchestrator

# omp (default): user-level extension
mkdir -p ~/.omp/agent/extensions
cp -r plugins/pipeline-orchestrator ~/.omp/agent/extensions/pipeline-orchestrator
```

<details>
<summary>Legacy Pi paths</summary>

```bash
cp -r plugins/pipeline-orchestrator ~/.pi/agent/extensions/pipeline-orchestrator
```

The plugin manifest keeps both `omp.extensions` and `pi.extensions`; `.pi/pipelines` and `.pi/agents` are still read as legacy fallbacks.
</details>

### 2. Define a pipeline

The fastest way is the [pipeline-setup](skills/pipeline-setup/SKILL.md) skill, which turns a compatible `SKILL.md` into a pipeline JSON and installs its agents:

```
/skill:pipeline-setup
configure the card-generator pipeline
```

Or write `.omp/pipelines/my-pipeline.json` yourself:

```json
{
  "name": "my-pipeline",
  "entityType": "topics",
  "entityDiscovery": { "pattern": "{work_dir}/inputs/" },
  "outputDir": "{work_dir}/outputs/{entity}/",
  "concurrency": 0,
  "maxIterations": 5,
  "variables": {
    "work_dir": { "description": "Working directory", "default": "." },
    "skill_dir": { "description": "Skill directory", "default": "/path/to/skill" }
  },
  "phases": [
    {
      "name": "generate",
      "agent": "generator",
      "taskTemplate": { "template": "Generate content for {entity}. Reference: {skill_dir}/references/", "variables": {} },
      "transition": {
        "routes": [
          { "if": { "exitCode": 0, "validatePassed": true }, "next": "review" },
          { "if": true, "next": "__LLM__", "prompt": "Generation failed. Review {entity} logs and decide." }
        ]
      }
    },
    {
      "name": "review",
      "agent": "reviewer",
      "taskTemplate": { "template": "Review output for {entity}: {outputDir}/result.txt", "variables": {} },
      "transition": {
        "routes": [
          { "if": { "outputContains": "VERDICT: PASS" }, "next": "done" },
          { "if": { "outputContains": "VERDICT: NOT PASS" }, "next": "generate", "iter": true },
          { "if": true, "next": "__LLM__", "prompt": "Unclear verdict. Inspect {entity}." }
        ]
      },
      "maxRetries": 3
    }
  ]
}
```

Agents are Markdown files with YAML frontmatter. Three discovery tiers apply, highest priority last:

```markdown
---
name: generator
description: Writes one deliverable per entity
tools: read, write, bash
---

You are the generator. Produce the requested file, then end with `VERDICT: PASS`.
```

```
.omp/agents/*.md          # project-level
~/.omp/agent/agents/*.md  # user-level
{skill_dir}/agents/*.md   # skill-level (highest)
```

### 3. Run it

```bash
/pipeline run my-pipeline --vars work_dir=/data,skill_dir=/path/to/skill
/pipeline run my-pipeline --entity "task-01"     # single entity
/pipeline status                                 # progress for all runs
/pipeline validate my-pipeline                   # config + agent checks
/pipeline graph my-pipeline                      # Mermaid flow diagram
/pipeline logs <pipelineId> --entity task-01     # tail phase logs
/pipeline stop <pipelineId>                      # pause (resumable)
/pipeline cancel <pipelineId>                    # cancel
```

`__LLM__` pauses the entity and injects the prompt into the current session. Inspect the output, then resume with the `pipeline_decide` tool — the freed concurrency slot lets other entities keep running.

---

## Features

| Feature | Description |
|:--|:--|
| **Declarative JSON** | State machines live in Git; review them like code |
| **Route table** | 10+ AND-combined condition types: `exitCode`, `validatePassed`, `outputContains`, `outputRegex` (+ `captureOp` numeric compare), `fileExists`, `fileMinSize`, `fileMaxSize`, `bash`, fallback `true` |
| **Parallel entities** | `concurrency: N` limits entities in flight; `0` = unlimited |
| **LLM decision points** | `__LLM__` releases the slot while waiting for `pipeline_decide` |
| **Resumable state** | Entity/phase state persisted to session entries (plus `memory` fallback); incomplete runs resume on restart |
| **Agent discovery** | Skill → project → user; `.omp` wins over legacy `.pi`; `$PI_CODING_AGENT_DIR` honored |
| **Template variables** | `{entity}`, `{iter}`, `{outputDir}`, `{lastOutput}`, `{lastPhaseSummary.verdict}`, `{lastPhaseSummary.keyFindings}`, custom `--vars` |
| **Structured output** | Sub-agents are asked to call `yield` with `{verdict, summary, keyFindings}`; summaries are stored per phase and usable in later prompts |
| **Conditional skip** | `skipIf` supports `bash`, `fileExists`, `fileNotExists` |
| **Output versioning** | `versionOutputs` prefixes artifacts with the iteration number |
| **Entity dependencies** | `entityDependencies` orders entities (fan-out / join patterns) |
| **Phase hooks** | `hooks.before` / `hooks.after` bash commands around the agent call |
| **Dual logs** | Human-readable `.log` + machine-readable `.trace.jsonl`, `tail -f` friendly |

The full schema, route-condition reference, and decision-mode guide live in [the plugin README](plugins/pipeline-orchestrator/README.md).

---

## Architecture

```
pipeline.json ──▶ executePipelineRun() ──▶ semaphore (concurrency)
                      │
                      ├─ entity auto-discovery (pattern + exclude)
                      ├─ agent discovery (skill → project → user)
                      ├─ template variable rendering
                      └─ route table (condition matching)
                              │
        entity₁ ──▶ phaseLoop   entity₂ ──▶ phaseLoop   entity₃ ──▶ phaseLoop
                              │
                              ├─ createAgentSession() — in-process sub-agent
                              ├─ streaming log + JSON trace
                              ├─ validate (bash, exit 0 = pass)
                              ├─ __LLM__ pause ──▶ pipeline_decide()
                              ├─ yield ──▶ PhaseSummary (verdict + findings)
                              └─ state persisted ──▶ resumable
```

Sub-agents run in-process through omp's `createAgentSession` SDK; the v1 engine spawned `pi` CLI subprocesses and parsed their JSON streams. The in-process design removed that parsing layer and gives direct access to structured events (`tool_execution_*`, `message_update`, `yield`).

---

## Repository layout

```
pi-pipeline-orchestrator/
├── plugins/pipeline-orchestrator/   # the extension: engine, routing, state, agents
├── skills/pipeline-setup/           # SKILL.md that generates pipelines + installs agents
├── docs/                            # evolution design notes and release notes
├── scripts/check-repo.mjs           # offline consistency/link/secret checks (CI)
├── SECURITY.md
├── CHANGELOG.md
├── tsconfig.json
└── package.json
```

---

## Related work: Claude Code Dynamic Workflows

Anthropic's Claude Code ships a [dynamic-workflows feature](https://code.claude.com/docs/en/workflows) that lets the model write JavaScript to orchestrate many sub-agents — the same broad direction: move orchestration from the context window into executable structure. The trade-offs differ:

| | Claude Code Dynamic Workflows | Pipeline Orchestrator |
|:--|:--|:--|
| **Definition** | Natural language → model writes JS | SKILL.md → generated JSON → human confirmation |
| **Auditability** | Generated script, inspectable with extra steps | Plain JSON in Git, diffable per change |
| **Decisions** | Runs start to finish unattended | Route table + `__LLM__` pause for a human/LLM call |
| **Quality gates** | Agents verify each other | Retry + `validate` bash gate + review phases |
| **Portability** | Tied to Claude Code and Anthropic models | Vendor-neutral: any model available in the pi/omp ecosystem |
| **Cost control** | Token spend scales with fan-out | Local models possible; `concurrency` caps the fan-out |

Neither is a drop-in replacement for the other: generated scripts are flexible for one-off exploration; a declared state machine is easier to review, rerun, and standardize.

---

## Getting help

The codebase is ~2,900 lines of TypeScript across six files and is meant to be readable. If something breaks:

1. **Ask your AI assistant** — share the error plus the relevant file (`index.ts`, `pipeline.ts`, `state.ts`, `agents.ts`).
2. **Open an issue** — [GitHub Issues](https://github.com/varsian/pi-pipeline-orchestrator/issues) for bugs and feature requests; see [SECURITY.md](SECURITY.md) for vulnerabilities (do not open a public issue).
3. **Send a PR** — focus on the plugin README for behavior changes; `node scripts/check-repo.mjs` and `npx tsc --noEmit` must pass.

---

## License

[GNU AGPL v3](LICENSE) © varsian
