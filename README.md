# Pipeline Orchestrator for omp

**Declarative multi-agent pipeline orchestration engine** — JSON-defined state machines, parallel sub-agent execution, retry, LLM decision points, and resumable state.

```bash
/pipeline run my-pipeline --vars work_dir=/data,tool_dir=/opt
```

> [中文文档](README_zh.md)

---

## Why this exists

When your task goes from "have AI edit one file" to "have AI process 50 modules, each requiring generation, review, and classification passes", a single conversation isn't enough. You need **orchestration**.

Pipeline-Orchestrator takes the orchestration logic out of your prompt and puts it into an **auditable, version-controlled, reusable JSON definition**, then lets the plugin engine schedule sub-agents automatically.

---

## vs. Claude Code Dynamic Workflows

On May 28, 2026, Anthropic released [Claude Code Dynamic Workflows](https://code.claude.com/docs/en/workflows) — a feature that lets Claude write JavaScript scripts to orchestrate hundreds of sub-agents.

Pipeline-Orchestrator independently solved the same architectural problem before that date. Both share the same goal: **moving the multi-agent orchestration plan out of the model's context window and into executable code**. But the approach differs:

| | Claude Dynamic Workflows | Pipeline-Orchestrator |
|:--|:--|:--|
| **Orchestration definition** | Natural language → model generates JS on the fly | SKILL.md → auto-generated JSON → human confirmation |
| **Auditability** | Black-box JS (extra steps required to inspect) | Fully transparent JSON, version-controlled in Git |
| **Decision model** | Script runs fully automated, no mid-run intervention | Route Table condition matching + `__LLM__` pause for human decision |
| **Quality assurance** | Adversarial verification (agents disprove each other) | Multi-retry + bash validate + human review gate |
| **Vendor lock-in** | Deeply tied to Claude model and Claude Code platform | Vendor-neutral — any LLM in the pi ecosystem |
| **Cost** | 500-agent Opus 4.8 run can 10× your bill | Local models supported, costs fully under your control |

**The core difference**: Claude's path is "say one sentence, model writes a script, runs to completion" — flexible but opaque. Pipeline-Orchestrator's path is "write a structured spec, auto-generate config, human steps in at key points" — one extra step, but fully transparent. The former suits one-off exploratory tasks; the latter suits repeatable, standardized pipelines.

> For a detailed comparison, see the [research report](_research/claude-dynamic-workflow/report.md).

---

## Architecture

```
pipeline.json → executePipelineRun() → Semaphore pool
                     │
                     ├─ Entity auto-discovery
                     ├─ Agent 3-tier discovery (skill → project → user)
                     ├─ Template variable substitution
                     └─ Route Table
                             │
                             ├─ entity₁ → phaseLoop
                             ├─ entity₂ → phaseLoop
                             └─ entity₃ → phaseLoop
                                     │
                                     ├─ spawn("pi", ...) subprocess execution
                                     ├─ Streaming logs + JSON trace
                                     ├─ validate bash checks
                                     ├─ __LLM__ pause for human decision
                                     └─ State persistence (resumable)
```

---

## Quick Start

### 1. Install

```bash
git clone https://github.com/varsian/pi-pipeline-orchestrator
cd pi-pipeline-orchestrator
cp -r plugins/pipeline-orchestrator ~/.pi/agent/extensions/pipeline-orchestrator
```

### 2. Configure a pipeline

Use the [pipeline-setup](skills/pipeline-setup/SKILL.md) skill to auto-generate a pipeline definition from any compatible skill's SKILL.md:

```
/skill:pipeline-setup
configure the card-generator pipeline
```

Or write `.pi/pipelines/my-pipeline.json` manually:

```jsonc
{
  "name": "my-pipeline",
  "entityType": "topics",
  "entityDiscovery": { "pattern": "{work_dir}/inputs/" },
  "outputDir": "{work_dir}/outputs/{entity}/",
  "concurrency": 0,
  "maxIterations": 5,
  "phases": [
    {
      "name": "generate",
      "agent": "generator",
      "taskTemplate": {
        "template": "Generate content for {entity}. Reference: {skill_dir}/references/...",
        "variables": {}
      },
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
      "taskTemplate": {
        "template": "Review output for {entity}: {outputDir}/result.txt",
        "variables": {}
      },
      "transition": {
        "routes": [
          { "if": { "outputContains": "VERDICT: PASS" }, "next": "done" },
          { "if": { "outputContains": "VERDICT: NOT PASS" }, "next": "generate", "iter": true },
          { "if": true, "next": "__LLM__", "prompt": "Unclear verdict. Inspect {entity}." }
        ]
      },
      "maxRetries": 3
    }
  ],
  "variables": {
    "work_dir": { "description": "Working directory", "default": "." },
    "skill_dir": { "description": "Skill directory", "default": "/path/to/skill" }
  }
}
```

### 3. Run

```bash
# Multiple entities in parallel
/pipeline run my-pipeline --vars work_dir=/data,skill_dir=/path/to/skill

# Single entity
/pipeline run my-pipeline --entity "task-01"

# Check status
/pipeline status

# Pause / Cancel
/pipeline stop <pipelineId>
/pipeline cancel <pipelineId>
```

---

## Features

| Feature | Description |
|:--|:--|
| **Declarative JSON** | Version-controlled, auditable, reusable |
| **Route Table** | 10+ condition types (exitCode, outputContains, outputRegex, fileExists, etc.) |
| **Parallel execution** | `concurrency` field controls parallelism via semaphore |
| **LLM decision points** | `__LLM__` pauses for `pipeline_decide()`, releases slot so others continue |
| **Resumable state** | State persisted to session entries, auto-resume on restart |
| **Agent auto-discovery** | 3-tier priority: Skill → Project → User |
| **Template variables** | `{entity}` `{iter}` `{lastOutput}` `{outputDir}` and more |
| **Conditional skip** | `skipIf` supports bash / fileExists / fileNotExists |
| **Output versioning** | `versionOutputs` auto-prefixes with iteration number |
| **Entity dependencies** | `entityDependencies` declares execution order |
| **Phase hooks** | `hooks.before/after` bash commands around agent spawn |
| **Dual logging** | Human-readable log + JSON trace, `tail -f` friendly |

---

## File Structure

```
pipeline-orchestrator/
├── index.ts          # Entry: registers commands/tools, main execution loop, concurrency
├── pipeline.ts       # Execution engine: spawns sub-pi process, streaming logs, validate
├── state.ts          # State engine: persistence, route resolution, skipIf, templates
├── agents.ts         # Agent discovery: parses .md frontmatter, 3-tier priority
├── types.ts          # Type definitions
├── pi-types.d.ts     # pi runtime type stubs
├── package.json
└── README.md
```

---

## Companion Tools

| Tool | Description |
|:--|:--|
| [pipeline-setup](skills/pipeline-setup/SKILL.md) | Auto-generates pipeline JSON from SKILL.md and installs agents |
| pipeline-orchestrator plugin | Runtime engine (this project) |

---

## Getting Help

The codebase is small (8 source files) and structured for readability. If you run into issues:

1. **Ask your AI assistant** — share the error and relevant source files (`index.ts`, `pipeline.ts`, `state.ts`, etc.) with your AI coding assistant. Most issues can be diagnosed and fixed by having it read the code.
2. **Open an Issue** — bug reports and feature suggestions are welcome at [GitHub Issues](https://github.com/varsian/pi-pipeline-orchestrator/issues).
3. **Submit a PR** — if you've fixed a bug or added a feature, pull requests are appreciated.

---

## License

[GNU AGPL v3](LICENSE) © varsian
