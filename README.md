# Pipeline Orchestrator for pi

**声明式多 Agent 流水线编排引擎** — JSON 定义多阶段状态机，自动调度子 Agent 并行执行，支持重试、LLM 决策点、断点续跑。

```bash
/pipeline run my-pipeline --vars work_dir=/data,tool_dir=/opt
```

---

## 为什么你需要这个

当任务从"让 AI 帮我改一个文件"升级到"让 AI 帮我处理 50 个模块，每个模块要生成、审查、分类三轮"，单次对话就不够用了。你需要**编排**。

Pipeline-Orchestrator 把编排逻辑从你的 prompt 里拿出来，放进一个**可审计、可版本控制、可复用的 JSON 定义**，然后由插件引擎自动调度子 Agent 执行。

---

## 与 Claude Code Dynamic Workflows 的对比

2026 年 5 月 28 日，Anthropic 发布了 [Claude Code Dynamic Workflows](https://code.claude.com/docs/en/workflows)——一个让 Claude 写 JavaScript 脚本来自动编排数百个子 Agent 的功能。

Pipeline-Orchestrator 在此之前已独立完成了相同问题空间的架构设计。两者目标一致：**把多 Agent 编排计划从模型的上下文窗口移到可执行代码中**。但路线不同：

| | Claude Dynamic Workflows | Pipeline-Orchestrator |
|:--|:--|:--|
| **编排定义** | 自然语言 → 模型实时生成 JS 脚本 | SKILL.md → 自动生成 JSON → 人工确认 |
| **可审计性** | 黑盒 JS（需额外步骤查看） | 完全透明的 JSON，在 Git 中版本控制 |
| **决策方式** | 脚本全自动运行，无中途干预 | Route Table 条件匹配 + `__LLM__` 暂停等人类决策 |
| **质量保证** | 对抗性验证（Agent 互相否定发现） | 多重重试 + bash validate + 人工审查点 |
| **供应商绑定** | 深度绑定 Claude 模型和 Claude Code 平台 | 不绑定——pi 生态内使用任意 LLM |
| **成本** | Opus 4.8 500-Agent 运行可能 10x 账单 | 可用本地模型，成本完全可控 |

**核心差异**：Claude 的路线是"说一句话，模型写脚本，全自动跑到底"——灵活但不可控。Pipeline-Orchestrator 的路线是"写结构化描述，自动生成配置，人在关键点介入"——多一步配置但完全透明。前者适合一次性探索任务，后者适合重复性规范化流水线。

> 详细对比见 [_research/claude-dynamic-workflow/report.md](_research/claude-dynamic-workflow/report.md)

---

## 架构

```
pipeline.json → executePipelineRun() → Semaphore 并发池
                     │
                     ├─ entity 自动发现
                     ├─ Agent 三层发现（skill → 项目 → 用户）
                     ├─ 模板变量替换
                     └─ Route Table 路由
                             │
                             ├─ entity₁ → phaseLoop
                             ├─ entity₂ → phaseLoop
                             └─ entity₃ → phaseLoop
                                     │
                                     ├─ spawn("pi", ...)  子进程执行
                                     ├─ 流式日志 + JSON trace
                                     ├─ validate bash 校验
                                     ├─ __LLM__ 暂停等人工决策
                                     └─ 状态持久化（断点续跑）
```

---

## 快速开始

### 1. 安装

```bash
git clone https://github.com/varsian/pi-pipeline-orchestrator
cd pi-pipeline-orchestrator
cp -r plugins/pipeline-orchestrator ~/.pi/agent/extensions/pipeline-orchestrator
```

### 2. 配置流水线

使用 [pipeline-setup](skills/pipeline-setup/SKILL.md) skill 从任意兼容 skill 的 SKILL.md 自动生成流水线定义：

```
/skill:pipeline-setup
配置 card-generator 的流水线
```

或手动编写 `.pi/pipelines/my-pipeline.json`：

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
        "template": "为 {entity} 生成内容，参考 {skill_dir}/references/...",
        "variables": {}
      },
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
      "taskTemplate": {
        "template": "审查 {entity} 的输出：{outputDir}/result.txt",
        "variables": {}
      },
      "transition": {
        "routes": [
          { "if": { "outputContains": "VERDICT: PASS" }, "next": "done" },
          { "if": { "outputContains": "VERDICT: NOT PASS" }, "next": "generate", "iter": true },
          { "if": true, "next": "__LLM__", "prompt": "审查结果不明确，检查 {entity}" }
        ]
      },
      "maxRetries": 3
    }
  ],
  "variables": {
    "work_dir": { "description": "工作目录", "default": "." },
    "skill_dir": { "description": "Skill 目录", "default": "/path/to/skill" }
  }
}
```

### 3. 运行

```bash
# 多实体并行
/pipeline run my-pipeline --vars work_dir=/data,skill_dir=/path/to/skill

# 单实体
/pipeline run my-pipeline --entity "task-01"

# 查看状态
/pipeline status

# 暂停/取消
/pipeline stop <pipelineId>
/pipeline cancel <pipelineId>
```

---

## 特性

| 特性 | 说明 |
|:--|:--|
| **声明式 JSON 定义** | 版本控制、可审计、可复用 |
| **Route Table 路由** | 10+ 种条件类型（exitCode、outputContains、outputRegex、fileExists 等） |
| **并行执行** | `concurrency` 控制并发数，信号量管理 |
| **LLM 决策点** | `__LLM__` 暂停等 `pipeline_decide()`，释放槽位不阻塞其他实体 |
| **断点续跑** | 状态持久化到会话条目，会话重启自动恢复 |
| **Agent 自动发现** | 3 层优先级：Skill → 项目 → 用户 |
| **模板变量** | `{entity}` `{iter}` `{lastOutput}` `{outputDir}` 等 |
| **阶段跳过** | `skipIf` 支持 bash/fileExists/fileNotExists |
| **输出版本化** | `versionOutputs` 自动加迭代前缀 |
| **实体依赖** | `entityDependencies` 声明执行顺序 |
| **阶段钩子** | `hooks.before/after` Agent spawn 前后 bash 命令 |
| **双日志** | 人类可读日志 + JSON trace，支持 `tail -f` |

---

## 文件结构

```
pipeline-orchestrator/
├── index.ts          # 入口：注册命令/工具，主执行循环，并发控制
├── pipeline.ts       # 执行引擎：spawn 子 pi 进程，流式日志，validate
├── state.ts          # 状态引擎：持久化、路由解析、skipIf、模板渲染
├── agents.ts         # Agent 发现：解析 .md frontmatter，3 层优先级
├── types.ts          # 类型定义
├── pi-types.d.ts     # pi 运行时类型桩
├── package.json
└── README.md
```

---

## 配套工具

| 工具 | 说明 |
|:--|:--|
| [pipeline-setup](skills/pipeline-setup/SKILL.md) | 从 SKILL.md 自动生成 pipeline JSON 和安装 agent |
| pipeline-orchestrator 插件 | 运行时引擎（本项目） |

---

## 遇到问题？

这个项目的代码量不大（8 个源文件），结构清晰。如果你在使用中遇到问题：

1. **让你的 AI 助手帮你**——把报错信息和相关源文件（`index.ts`、`pipeline.ts`、`state.ts` 等）发给你的 AI 编程助手，让它读代码定位问题。大部分情况下它能直接给出修改方案。
2. **提 Issue**——欢迎到 [GitHub Issues](https://github.com/varsian/pi-pipeline-orchestrator/issues) 报告 bug 或提功能建议。
3. **提 PR**——如果你修复了某个问题或添加了新功能，欢迎提交 Pull Request。

---

## 许可证

[Apache 2.0](LICENSE) © varsian
