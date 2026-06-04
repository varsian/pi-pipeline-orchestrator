# Pipeline Orchestrator

声明式流水线编排插件。通过 JSON 定义多阶段状态机，自动调度子 Agent 执行，支持并行、重试、LLM 决策点、断点续跑。

## 安装

将插件目录放到 pi 的扩展路径下：

```bash
cp -r plugins/pipeline-orchestrator ~/.pi/agent/extensions/pipeline-orchestrator
```

pi 启动时自动加载 `package.json` 中 `pi.extensions` 声明的入口文件 `index.ts`。

> 配合 **pipeline-setup** skill 使用：该 skill 读取任意兼容 skill 的 SKILL.md 和 agents/，
> 自动生成 `.pi/pipelines/{name}.json` 和安装 agent 文件，无需手写 pipeline JSON。

## 前置依赖

| 依赖 | 最低版本 | 说明 |
|:--|:--|:--|
| pi | ≥ 当前支持 ExtensionAPI 的版本 | 插件注册依赖 `registerCommand`、`registerTool`、`appendEntry`、`sendUserMessage` |
| Node.js | ≥ 18 | `fs.rmSync`（替代弃用的 `rmdirSync`）、`AbortSignal.timeout()` |

## 架构

```
pipeline.json → executePipelineRun() → Semaphore 池
                  │                        │
                  ├─ entity 发现            ├─ entity₁ → phaseLoop
                  ├─ Agent 发现             ├─ entity₂ → phaseLoop
                  ├─ 变量替换              └─ entity₃ → phaseLoop
                  └─ Route 路由                  │
                                                  ├─ spawn("pi", ...)
                                                  ├─ 流式日志 + trace
                                                  ├─ validate bash
                                                  ├─ __LLM__ 暂停
                                                  └─ 状态持久化
```

## 命令

| 命令 | 说明 |
|:--|:--|
| `/pipeline run <name> --vars k=v,...` | 阻塞执行（发现实体 → 逐阶段推进） |
| `/pipeline run <name> --entity <id> --vars k=v,...` | 单实体执行 |
| `/pipeline status` | 查看所有流水线状态 |
| `/pipeline list` | 列出可用流水线定义 |
| `/pipeline stop <id>` | 暂停（保留进度，可续跑） |
| `/pipeline cancel <id>` | 取消（标记失败） |

## 工具（LLM 可调用）

| 工具 | 说明 |
|:--|:--|
| `pipeline_decide(pipelineId, entityId, decision)` | LLM 决策点响应 |
| `pipeline_status(pipelineId?)` | 查询状态 |
| `pipeline_stop(pipelineId)` | 暂停 |
| `pipeline_cancel(pipelineId)` | 取消 |

## Pipeline JSON 定义

```jsonc
{
  "name": "my-pipeline",           // 流水线名
  "entityType": "topics",          // 实体类型标签
  "entityDiscovery": {             // 可选：自动发现
    "pattern": "{work_dir}/inputs/",
    "exclude": ["skip_this"]       // 排除目录
  },
  "outputDir": "{work_dir}/outputs/{entity}/",
  "concurrency": 0,                // 0=无限, 1=串行, N=并行上限（默认0）
  "maxIterations": 5,              // 循环阶段上限（默认5）
  "variables": {                   // 模板变量
    "work_dir": { "description": "工作目录", "default": "." },
    "tool_dir": { "description": "工具目录", "default": "/opt/tools" }
  },
  "phases": [
    // 阶段定义见下方
  ]
}
```

### PhaseDefinition

```jsonc
{
  "name": "phase_name",            // 阶段名（路由目标）
  "label": "可读标签",             // 可选
  "agent": "agent-name",           // 对应 agents/*.md 的 name 字段
  "taskTemplate": {
    "template": "处理 {entity}，输入 {work_dir}/data/...",
    "variables": {}                // 模板局部变量（可选）
  },
  "transition": { ... },           // 路由（见下方）
  "validate": "bash命令",          // 可选：阶段完成后校验（exit 0=通过）
  // 或对象形式
  "validate": { "bash": "test -f {outputDir}/result.txt" },
  "maxRetries": 3,                 // 失败重试次数（默认3）
  "timeoutMinutes": 30,            // 超时分钟（默认30）
  "model": "deepseek-v4-pro",      // 覆盖 Agent 默认模型
  "tools": "read,write,bash",      // 覆盖 Agent 默认工具
  "versionOutputs": ["all.txt"],   // 自动版本化：all.txt → 1-all.txt
  "skipIf": {                      // 实体级跳过条件
    "bash": "test ! -f {outputDir}/all.txt",
    "fileExists": "{work_dir}/markers/done",
    "fileNotExists": "{work_dir}/markers/skip"
  },
  "skipReason": "原因说明"
}
```

### Transition 路由

新版 Route Table（推荐）：

```jsonc
"transition": {
  "routes": [
    // 条件路由（所有条件 AND 匹配）
    { "if": { "exitCode": 0, "validatePassed": true }, "next": "next_phase" },
    // 输出内容匹配
    { "if": { "outputContains": "VERDICT: PASS" }, "next": "advance" },
    { "if": { "outputContains": "VERDICT: NOT PASS" }, "next": "retry", "iter": true },
    // 兜底匹配
    { "if": true, "next": "__LLM__", "prompt": "检查 {entity} 后决定" }
  ]
}
```

旧版兼容（仍支持）：

| type | 行为 |
|:--|:--|
| `"auto"` | 线性前进到下一阶段 |
| `"llm"` | 暂停等 `pipeline_decide` |
| `"conditional"` | 等 pass/loop 决策 |
| `"manual"` | 等任意阶段名 |

### RouteCondition 条件类型

| 条件 | 类型 | 说明 |
|:--|:--|:--|
| `exitCode` | number | Agent 退出码 |
| `validatePassed` | boolean | validate 命令结果 |
| `outputContains` | string | Agent 输出包含此文本 |
| `outputRegex` | string | 正则匹配（捕获组可用 captureOp） |
| `captureOp` | object | `{op:"eq"/"gt"/"gte", value:N}` 数值比较 |
| `fileExists` | string | 文件存在（支持 `{变量}`） |
| `fileMinSize` | object | `{path:"...", bytes:N}` 最小文件大小 |
| `fileMaxSize` | object | `{path:"...", bytes:N}` 最大文件大小 |
| `bash` | string | bash 命令 exit 0=匹配 |
| `default` | true | 无其他条件时匹配 |

### 特殊路由目标

| 目标 | 行为 |
|:--|:--|
| `"phase_name"` | 跳转到指定阶段 |
| `"done"` | 标记实体完成 |
| `"__LLM__"` | 暂停等 LLM 决策，需 `prompt` 字段 |
| `"__COND__"` | 暂停等 pass/loop 决策 |
| `"__MANUAL__"` | 暂停等任意阶段名 |
| `"__NEXT__"` | 线性下一阶段 |

## 决策模式

流水线支持两种决策方式，不需要修改插件代码：

### 子 Agent 决策（推荐）

在 Agent prompt 末尾要求输出特定标记，route table 用 `outputContains` 匹配：

```jsonc
{
  "name": "review_phase",
  "agent": "my-reviewer",
  "transition": {
    "routes": [
      { "if": { "outputContains": "DECISION: PASS" },     "next": "next_phase" },
      { "if": { "outputContains": "DECISION: RETRY" },    "next": "prev_phase", "iter": true },
      { "if": true, "next": "__LLM__", "prompt": "Agent 无决策，手动处理 {entity}" }
    ]
  }
}
```

- `iter: true` 消耗一次迭代，`iter: false`（或省略）不消耗
- `maxIterations`（默认 5）控制循环上限，超限标记失败
- 兜底 `{ "if": true }` 防止 Agent 未按约定输出时死循环
- 适用于判断标准可由 prompt 编码的场景（质量审查、内容校验等）

### LLM 决策

使用 `__LLM__` 特殊目标，暂停等当前窗口 LLM 调用 `pipeline_decide()`：

```jsonc
{ "if": true, "next": "__LLM__", "prompt": "检查 {entity} 后决定下一步" }
```

- 管道释放并发槽位，其他 Entity 继续执行
- 当前窗口收到 prompt 后，LLM 可读文件、修改内容
- 最后调用 `pipeline_decide(pipelineId, entityId, "phase_name")` 恢复执行
- 适用于需要灵活判断、无固定输出格式的决策点

| 模式 | 配置 | 决策者 | 适用场景 |
|:--|:--|:--|:--|
| 子 Agent 决策 | `outputContains` + `iter` | Agent 输出标记 | 判断标准明确，可编码为 prompt |
| LLM 决策 | `"__LLM__"` + `prompt` | 当前窗口调 `pipeline_decide()` | 灵活判断，需读写文件后决定 |

## 任务模板变量

| 变量 | 说明 |
|:--|:--|
| `{entity}` | 当前实体 ID |
| `{pipelineId}` | 流水线 ID |
| `{iter}` | 当前迭代序号 |
| `{iterPrev}` | 上一迭代序号 |
| `{lastOutput}` | 上一阶段 Agent 输出文本 |
| `{outputDir}` | 输出目录完整路径 |
| `{output}` | 上一阶段日志路径（`{outputDir}/.agent-{phase}.log`） |
| `{output:phaseName}` | 指定阶段日志路径 |
| `{outputDirFiles}` | 输出目录文件列表 |
| `{自定义}` | 来自 `variables` 或 `--vars` |

## Agent 发现

3 层优先级（高到低）：

1. **Skill 级** — `{skill_dir}/agents/*.md`（最高优先级）
2. **项目级** — `.pi/agents/*.md`
3. **用户级** — `~/.pi/agent/agents/*.md`

Agent `.md` 格式：

```markdown
---
name: my-agent
description: 做什么的
tools: read, write, bash     # 可选
model: deepseek-v4-pro       # 可选
---

这里是 system prompt 正文...
```

## 并发

```jsonc
{ "concurrency": 0 }  // 0 或不设 = 无限
{ "concurrency": 3 }  // 最多 3 个 entity 同时跑
{ "concurrency": 1 }  // 串行（向后兼容）
```

- 每个 entity 独立运行 phaseLoop，共享信号量槽位
- entity 进入 `__LLM__` 等待时**释放槽位**，决定后重新获取
- 状态栏格式：`[3/26] ▶media ▶万有引力 💬光的干涉`

## 日志

每个 entity 独立输出目录：

```
{outputDir}/.agent-{phase}.log         — 人类可读流式日志（可 tail -f）
{outputDir}/.agent-{phase}.trace.jsonl — 完整 JSON trace
```

日志格式修复要点：
- `thinking_delta` 用 `inner.delta`（增量），不用 `partial.content[].thinking`（累积）
- `toolcall_start` 标记为 `📎 [toolName] fileName`

## 状态持久化

通过 `pi.appendEntry("pipeline-state", record)` 持久化，会话重启自动恢复。`findIncompleteByName()` 检测未完成流水线并断点续跑。

## 执行流程

```
/pipeline run <name> --vars ...
  │
  ├─ 加载 .pi/pipelines/<name>.json
  ├─ 发现实体（entityDiscovery.pattern + exclude）
  ├─ 发现 Agent（user → project → skill）
  ├─ 注入默认变量
  ├─ 检查未完成流水线 → 续跑
  │
  └─ executePipelineRun()
       │
       └─ processEntity(entity₁..entityₙ) [并行/串行]
            │
            phaseLoop: while true
              ├─ skipIf 检查
              ├─ 无 Agent → 直接路由
              ├─ 有 Agent → spawn("pi", ...)
              │    ├─ 流式日志 + trace
              │    ├─ 保存 lastOutput / phaseOutputs
              │    └─ versionOutputs
              ├─ 失败 → retry (maxRetries)
              ├─ validate bash 命令
              └─ resolveRoute → 下一阶段 / __LLM__ / done
```

## 使用示例

```bash
# 多实体并行
/pipeline run my-pipeline --vars work_dir=/data,tool_dir=/opt

# 单实体
/pipeline run my-pipeline --entity "task-01" --vars work_dir=/data
```

## 文件结构

```
pipeline-orchestrator/
├── index.ts          # 入口：注册命令、工具、executePipelineRun 主循环
├── pipeline.ts       # 执行引擎：spawn 子 pi 进程、流式日志、validate
├── state.ts          # 状态引擎：持久化、路由解析、skipIf、模板渲染
├── agents.ts         # Agent 发现：解析 .md frontmatter、3 层优先级
├── types.ts          # 类型定义：PipelineDefinition、PhaseDefinition 等
├── pi-types.d.ts     # pi 运行时类型桩（开发用，运行时 pi 注入）
├── package.json      # 插件元数据
├── .gitignore
└── README.md
```
