# Pipeline Orchestrator

**面向 pi 编码智能体生态的声明式多 Agent 流水线引擎。** 用 JSON 状态机描述多阶段工作流——引擎自动发现实体、并行调度子 Agent、失败重试、在 LLM 决策点暂停，并在重启后断点续跑。

[![CI](https://github.com/varsian/pi-pipeline-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/varsian/pi-pipeline-orchestrator/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](CHANGELOG.md)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](package.json)
[![Runs on omp](https://img.shields.io/badge/runs%20on-omp%20%28oh--my--pi%29-5B8DEF)](https://github.com/can1357/oh-my-pi)

> [English](README.md)

**运行时说明：** 引擎面向 [omp](https://github.com/can1357/oh-my-pi)（`@oh-my-pi/pi-coding-agent`，[Pi](https://github.com/badlogic/pi-mono) 的活跃分支），通过其 Agent SDK 在进程内运行子 Agent。插件仍兼容旧版 `pi.extensions` 清单和 `.pi/` 配置路径；在原生 Pi 上使用需要替换 SDK 导入（见[插件 README](plugins/pipeline-orchestrator/README.md#runtime-and-compatibility)）。

**状态：** v2.0.0，早期阶段。流水线定义是可执行的配置——它可以执行 `bash` 校验命令和 hooks——因此只运行你信任的流水线。详见 [SECURITY.md](SECURITY.md)。

---

## 为什么需要它

单次对话适合"帮我改一个文件"。但当任务变成"处理 50 个输入，每个都要生成 → 审查 → 分类三轮，中途还要人工裁决，崩溃后要能续跑，并且事后能查清发生了什么"，单次对话就不够用了。

Pipeline Orchestrator 把编排逻辑从 prompt 里搬到**受版本控制的 JSON 状态机**：工作流可以评审、可以 diff，引擎负责调度子 Agent。

---

## 快速开始

### 1. 安装插件

```bash
git clone https://github.com/varsian/pi-pipeline-orchestrator
cd pi-pipeline-orchestrator

# omp（默认）：安装为用户级扩展
mkdir -p ~/.omp/agent/extensions
cp -r plugins/pipeline-orchestrator ~/.omp/agent/extensions/pipeline-orchestrator
```

<details>
<summary>旧版 Pi 路径</summary>

```bash
cp -r plugins/pipeline-orchestrator ~/.pi/agent/extensions/pipeline-orchestrator
```

插件清单同时声明了 `omp.extensions` 和 `pi.extensions`；`.pi/pipelines` 和 `.pi/agents` 仍作为旧版路径回退读取。
</details>

### 2. 定义流水线

最快的方式是用 [pipeline-setup](skills/pipeline-setup/SKILL.md) skill，把兼容的 `SKILL.md` 转成流水线 JSON 并安装 Agent：

```
/skill:pipeline-setup
配置 card-generator 的流水线
```

也可以手写 `.omp/pipelines/my-pipeline.json`：

```json
{
  "name": "my-pipeline",
  "entityType": "topics",
  "entityDiscovery": { "pattern": "{work_dir}/inputs/" },
  "outputDir": "{work_dir}/outputs/{entity}/",
  "concurrency": 0,
  "maxIterations": 5,
  "variables": {
    "work_dir": { "description": "工作目录", "default": "." },
    "skill_dir": { "description": "Skill 目录", "default": "/path/to/skill" }
  },
  "phases": [
    {
      "name": "generate",
      "agent": "generator",
      "taskTemplate": { "template": "为 {entity} 生成内容，参考 {skill_dir}/references/", "variables": {} },
      "transition": {
        "routes": [
          { "if": { "exitCode": 0, "validatePassed": true }, "next": "review" },
          { "if": true, "next": "__LLM__", "prompt": "生成失败，审查 {entity} 的日志后决定" }
        ]
      }
    },
    {
      "name": "review",
      "agent": "reviewer",
      "taskTemplate": { "template": "审查 {entity} 的输出：{outputDir}/result.txt", "variables": {} },
      "transition": {
        "routes": [
          { "if": { "outputContains": "VERDICT: PASS" }, "next": "done" },
          { "if": { "outputContains": "VERDICT: NOT PASS" }, "next": "generate", "iter": true },
          { "if": true, "next": "__LLM__", "prompt": "审查结果不明确，检查 {entity}" }
        ]
      },
      "maxRetries": 3
    }
  ]
}
```

Agent 是带 YAML frontmatter 的 Markdown 文件。三层发现，优先级由低到高：

```markdown
---
name: generator
description: 为每个实体生成一份交付物
tools: read, write, bash
---

你是生成器。产出要求的文件，最后输出 `VERDICT: PASS`。
```

```
.omp/agents/*.md          # 项目级
~/.omp/agent/agents/*.md  # 用户级
{skill_dir}/agents/*.md   # Skill 级（最高）
```

### 3. 运行

```bash
/pipeline run my-pipeline --vars work_dir=/data,skill_dir=/path/to/skill
/pipeline run my-pipeline --entity "task-01"     # 单实体
/pipeline status                                 # 所有运行的状态
/pipeline validate my-pipeline                   # 校验配置与 Agent
/pipeline graph my-pipeline                      # 输出 Mermaid 流程图
/pipeline logs <pipelineId> --entity task-01     # 查看阶段日志
/pipeline stop <pipelineId>                      # 暂停（可续跑）
/pipeline cancel <pipelineId>                    # 取消
```

`__LLM__` 会暂停该实体，把提示注入当前会话；你查看产物后用 `pipeline_decide` 工具恢复执行——释放的并发槽位让其他实体继续跑。

---

## 特性

| 特性 | 说明 |
|:--|:--|
| **声明式 JSON** | 状态机入库，像代码一样评审 |
| **Route Table** | 10+ 种 AND 组合条件：`exitCode`、`validatePassed`、`outputContains`、`outputRegex`（+ `captureOp` 数值比较）、`fileExists`、`fileMinSize`、`fileMaxSize`、`bash`、兜底 `true` |
| **实体并行** | `concurrency: N` 控制同时在跑的实体数，`0` = 不限制 |
| **LLM 决策点** | `__LLM__` 等待 `pipeline_decide` 期间释放并发槽位 |
| **断点续跑** | 状态持久化到会话条目（含 `memory` 回退）；未完成运行在重启后恢复 |
| **Agent 自动发现** | Skill → 项目 → 用户；`.omp` 优先于旧版 `.pi`；支持 `$PI_CODING_AGENT_DIR` |
| **模板变量** | `{entity}`、`{iter}`、`{outputDir}`、`{lastOutput}`、`{lastPhaseSummary.verdict}`、`{lastPhaseSummary.keyFindings}` 以及 `--vars` 自定义变量 |
| **结构化输出** | 子 Agent 被要求调用 `yield` 返回 `{verdict, summary, keyFindings}`；摘要按阶段保存，可注入后续 prompt |
| **条件跳过** | `skipIf` 支持 `bash`、`fileExists`、`fileNotExists` |
| **输出版本化** | `versionOutputs` 自动给产物加迭代序号前缀 |
| **实体依赖** | `entityDependencies` 声明执行顺序（fan-out / join） |
| **阶段钩子** | `hooks.before` / `hooks.after` 在 Agent 调用前后执行 bash |
| **双日志** | 人类可读 `.log` + 机器可读 `.trace.jsonl`，支持 `tail -f` |

完整 schema、路由条件参考和决策模式说明见[插件 README](plugins/pipeline-orchestrator/README.md)。

---

## 架构

```
pipeline.json ──▶ executePipelineRun() ──▶ 信号量（concurrency）
                      │
                      ├─ 实体自动发现（pattern + exclude）
                      ├─ Agent 发现（skill → project → user）
                      ├─ 模板变量渲染
                      └─ Route Table（条件匹配）
                              │
        entity₁ ──▶ phaseLoop   entity₂ ──▶ phaseLoop   entity₃ ──▶ phaseLoop
                              │
                              ├─ createAgentSession() —— 进程内子 Agent
                              ├─ 流式日志 + JSON trace
                              ├─ validate（bash，exit 0 = 通过）
                              ├─ __LLM__ 暂停 ──▶ pipeline_decide()
                              ├─ yield ──▶ PhaseSummary（verdict + findings）
                              └─ 状态持久化 ──▶ 断点续跑
```

子 Agent 通过 omp 的 `createAgentSession` SDK 在进程内运行；v1 引擎会 spawn `pi` CLI 子进程并解析其 JSON 流，进程内方案去掉了这层解析，并可直接消费结构化事件（`tool_execution_*`、`message_update`、`yield`）。

---

## 仓库结构

```
pi-pipeline-orchestrator/
├── plugins/pipeline-orchestrator/   # 插件：引擎、路由、状态、Agent 发现
├── skills/pipeline-setup/           # 生成流水线并安装 Agent 的 SKILL.md
├── docs/                            # 进化设计笔记与发布说明
├── scripts/check-repo.mjs           # 离线一致性/链接/密钥检查（CI）
├── SECURITY.md
├── CHANGELOG.md
├── tsconfig.json
└── package.json
```

---

## 相关工作：Claude Code Dynamic Workflows

Anthropic 的 Claude Code 提供 [dynamic workflows](https://code.claude.com/docs/en/workflows) 功能，允许模型编写 JavaScript 编排大量子 Agent——方向相同：**把多 Agent 编排从上下文窗口移到可执行结构里**。两者取舍不同：

| | Claude Code Dynamic Workflows | Pipeline Orchestrator |
|:--|:--|:--|
| **定义方式** | 自然语言 → 模型实时生成 JS | SKILL.md → 生成 JSON → 人工确认 |
| **可审计性** | 生成脚本，需额外步骤查看 | 纯 JSON 入 Git，逐次改动可 diff |
| **决策方式** | 全自动跑完，无中途干预 | Route Table + `__LLM__` 暂停等人工/LLM 裁决 |
| **质量保证** | Agent 互相验证 | 重试 + `validate` bash 校验 + 审查阶段 |
| **可移植性** | 绑定 Claude Code 与 Anthropic 模型 | 供应商中立：pi/omp 生态内任意模型 |
| **成本控制** | 开销随 fan-out 增长 | 可用本地模型；`concurrency` 限制 fan-out |

两者并非互相替代：生成脚本适合一次性探索；声明式状态机更适合可评审、可重跑、可标准化的流水线。

---

## 遇到问题？

代码量约 2,900 行 TypeScript、六个文件，结构清晰。遇到问题时：

1. **让你的 AI 助手帮你**——把报错信息和相关文件（`index.ts`、`pipeline.ts`、`state.ts`、`agents.ts`）发给它。
2. **提 Issue**——bug 与功能建议请到 [GitHub Issues](https://github.com/varsian/pi-pipeline-orchestrator/issues)；安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要公开提 Issue。
3. **提 PR**——改了插件行为请同步插件 README；`node scripts/check-repo.mjs` 与 `npx tsc --noEmit` 必须通过。

---

## 许可证

[GNU AGPL v3](LICENSE) © varsian
