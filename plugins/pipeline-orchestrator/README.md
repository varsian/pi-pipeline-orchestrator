# Pipeline Orchestrator

**In short (English):** an omp/pi extension that executes JSON-defined multi-phase agent pipelines — parallel entities, retry, route-table decisions, resumable state. A pipeline definition can run `bash` validation commands and hooks, so treat it as executable configuration and only run pipelines you trust (see [SECURITY.md](../../SECURITY.md)). Full reference below is primarily in Chinese.

声明式流水线编排插件。用 JSON 定义多阶段状态机，自动调度子 Agent 执行，支持并行、重试、LLM 决策点、断点续跑。

## Runtime and compatibility

- **Primary runtime:** [omp](https://github.com/can1357/oh-my-pi)（`@oh-my-pi/pi-coding-agent`）。插件通过 `createAgentSession()` 在进程内运行子 Agent。
- **Legacy:** 保留 `pi.extensions` 清单块、`.pi/pipelines`、`.pi/agents` 路径与 `pi` 时代的 `ExtensionAPI`（命令/工具/`appendEntry`/`sendUserMessage`）。omp 本身接受旧版 `pi.extensions` 清单和 `.pi` 项目覆盖查找。
- **Upstream Pi:** 引擎直接 `import` 自 `@oh-my-pi/pi-coding-agent`；在原生 Pi 上运行需要把该导入换成对应 Pi SDK 包并验证 `createAgentSession` 选项兼容性。
- **Node.js ≥ 22**（使用了 `Promise.withResolvers`、`AbortSignal.timeout()` 等较新 API）。

## 安装

将插件目录放到 omp 的扩展路径下：

```bash
# omp（默认）
mkdir -p ~/.omp/agent/extensions
cp -r plugins/pipeline-orchestrator ~/.omp/agent/extensions/pipeline-orchestrator

# 旧版 Pi 布局
cp -r plugins/pipeline-orchestrator ~/.pi/agent/extensions/pipeline-orchestrator
```

omp 启动时自动加载 `package.json` 中 `omp.extensions` 声明的入口文件 `index.ts`（旧版运行时读取 `pi.extensions`，同样指向该文件）。

> 配合 **pipeline-setup** skill 使用：该 skill 读取任意兼容 skill 的 SKILL.md 和 agents/，自动生成流水线 JSON 并安装 agent 文件，无需手写。

---

## 命令

| 命令 | 说明 |
|:--|:--|
| `/pipeline run <name> --vars k=v,...` | 阻塞执行（发现实体 → 逐阶段推进） |
| `/pipeline run <name> --entity <id> --vars k=v,...` | 单实体执行 |
| `/pipeline validate <name>` | 校验定义 + 检查引用的 agent 是否存在 |
| `/pipeline graph <name>` | 输出 Mermaid 流程图 |
| `/pipeline logs <id> [--entity <e>] [--phase <p>] [--tail <n>]` | 查看阶段日志 |
| `/pipeline status` | 查看所有流水线状态 |
| `/pipeline list` | 列出可用流水线定义 |
| `/pipeline stop <id>` | 暂停（保留进度，可续跑） |
| `/pipeline cancel <id>` | 取消（标记失败） |

## 工具（LLM 可调用）

| 工具 | 说明 |
|:--|:--|
| `pipeline_decide(pipelineId, entityId, decision)` | LLM 决策点响应（恢复 `__LLM__` 暂停的实体） |
| `pipeline_status(pipelineId?)` | 查询状态 |
| `pipeline_stop(pipelineId)` | 暂停 |
| `pipeline_cancel(pipelineId)` | 取消 |

---

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
  "maxIterationsPerLoop": {        // 可选：按 loopId 独立上限
    "research_loop": 5,
    "code_loop": 3
  },
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
  "agent": "agent-name",           // 对应 agents/*.md 的 name 字段；省略则直接路由
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
  "model": "your-model-id",        // 覆盖 Agent 默认模型
  "tools": "read,write,bash",      // 覆盖 Agent 默认工具
  "versionOutputs": ["all.txt"],   // 自动版本化：all.txt → 1-all.txt
  "skipIf": {                      // 实体级跳过条件
    "bash": "test ! -f {outputDir}/all.txt",
    "fileExists": "{work_dir}/markers/done",
    "fileNotExists": "{work_dir}/markers/skip"
  },
  "skipReason": "原因说明",
  "hooks": {                       // Agent spawn 前后执行
    "before": "git worktree add ../wt-{entity} main",
    "after": "git worktree remove ../wt-{entity} --force 2>/dev/null; true"
  }
}
```

### Transition 路由

Route Table（推荐）：

```jsonc
"transition": {
  "routes": [
    // 条件路由（所有条件 AND 匹配）
    { "if": { "exitCode": 0, "validatePassed": true }, "next": "next_phase" },
    // 输出内容匹配
    { "if": { "outputContains": "VERDICT: PASS" }, "next": "done" },
    { "if": { "outputContains": "VERDICT: NOT PASS" }, "next": "generate", "iter": true },
    // 兜底匹配
    { "if": true, "next": "__LLM__", "prompt": "检查 {entity} 后决定" }
  ]
}
```

循环由 `iter: true` 的路由构成，`maxIterations` / `maxIterationsPerLoop` 是安全阀。校验器只拒绝**没有任何 `iter` 边**的环（那种环无法收敛）。

旧版兼容（仍接受）：

| type | 行为 |
|:--|:--|
| `"auto"` | 线性前进到下一阶段 |
| `"llm"` | 暂停等 `pipeline_decide` |
| `"manual"` | 等任意阶段名 |

> `"conditional"` 类型已废弃，校验器会拒绝加载；请改用 routes + `outputContains` 或 `"type": "llm"`。

### RouteCondition 条件类型

| 条件 | 类型 | 说明 |
|:--|:--|:--|
| `exitCode` | number | Agent 退出码 |
| `validatePassed` | boolean | validate 命令结果 |
| `outputContains` | string | Agent 输出包含此文本 |
| `outputRegex` | string | 正则匹配（捕获组可用 captureOp） |
| `captureOp` | object | `{op:"eq"/"neq"/"gt"/"gte"/"lt"/"lte", value:N}` 数值比较 |
| `fileExists` | string | 文件存在（支持 `{变量}`） |
| `fileMinSize` | object | `{path:"...", bytes:N}` 最小文件大小 |
| `fileMaxSize` | object | `{path:"...", bytes:N}` 最大文件大小 |
| `bash` | string | bash 命令 exit 0=匹配 |
| `default` | true | 无其他条件时匹配（也可直接写 `"if": true`） |

### 特殊路由目标

| 目标 | 行为 |
|:--|:--|
| `"phase_name"` | 跳转到指定阶段 |
| `"done"` | 标记实体完成 |
| `"__LLM__"` | 暂停等 LLM 决策，需 `prompt` 字段 |
| `"__COND__"` | 暂停等 pass/loop 决策（旧版 conditional 用） |
| `"__MANUAL__"` | 暂停等任意阶段名 |

写作占位符（**保存前必须翻译**，校验器会拒绝字面值）：

| 占位符 | 翻译为 |
|:--|:--|
| `"__NEXT__"` | phases 数组中紧接着的下一阶段 name |
| `"__SELF__"` | 当前阶段 name（配 `"iter": true` 实现循环） |

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
      { "if": { "outputContains": "DECISION: PASS" },  "next": "next_phase" },
      { "if": { "outputContains": "DECISION: RETRY" }, "next": "prev_phase", "iter": true },
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

- 流水线释放并发槽位，其他实体继续执行
- 当前窗口收到 prompt 后，LLM 可读文件、修改内容
- 最后调用 `pipeline_decide(pipelineId, entityId, "phase_name")` 恢复执行
- 适用于需要灵活判断、无固定输出格式的决策点

| 模式 | 配置 | 决策者 | 适用场景 |
|:--|:--|:--|:--|
| 子 Agent 决策 | `outputContains` + `iter` | Agent 输出标记 | 判断标准明确，可编码为 prompt |
| LLM 决策 | `"__LLM__"` + `prompt` | 当前窗口调 `pipeline_decide()` | 灵活判断，需读写文件后决定 |

## 结构化输出（yield）

每个阶段会向子 Agent 申请结构化结果：

```json
{ "verdict": "PASS | FAIL | UNCLEAR", "summary": "一行摘要", "keyFindings": ["..."] }
```

- 引擎为子 Agent 启用 `requireYieldTool` 并注册输出 schema；未调用 `yield` 时会发送一次提醒
- 结果存为 `PhaseSummary`，后续阶段可用 `{lastPhaseSummary.verdict}`、`{lastPhaseSummary.keyFindings}` 引用
- 没有 `yield` 数据时回退到从文本输出提取

## 任务模板变量

| 变量 | 说明 |
|:--|:--|
| `{entity}` | 当前实体 ID |
| `{pipelineId}` | 流水线 ID |
| `{iter}` | 当前迭代序号 |
| `{iterPrev}` | 上一迭代序号 |
| `{lastOutput}` | 上一阶段 Agent 输出文本 |
| `{lastPhaseSummary.verdict}` | 上一阶段结构化摘要：PASS/FAIL/UNCLEAR |
| `{lastPhaseSummary.keyFindings}` | 上一阶段关键发现（换行分隔） |
| `{outputDir}` | 输出目录完整路径 |
| `{output}` | 上一阶段日志路径（`{outputDir}/.agent-{phase}.log`） |
| `{output:phaseName}` | 指定阶段日志路径 |
| `{outputDirFiles}` | 输出目录文件列表 |
| `{自定义}` | 来自 `variables` 或 `--vars` |

## Agent 发现

3 层优先级（低到高，后者覆盖同名 Agent）：

1. **用户级** — `$PI_CODING_AGENT_DIR/agents/*.md`、`~/.omp/agent/agents/*.md`、`~/.pi/agent/agents/*.md`
2. **项目级** — `.omp/agents/*.md`、`.pi/agents/*.md`
3. **Skill 级** — `{skill_dir}/agents/*.md`（最高优先级）

同一层内 `.omp` 路径优先于旧版 `.pi` 路径。Agent `.md` 格式：

```markdown
---
name: my-agent
description: 做什么的
tools: read, write, bash     # 可选
model: your-model-id         # 可选
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

`/pipeline logs <id> --entity <e> --phase <p> --tail <n>` 直接查看。

## 状态持久化

通过 `pi.appendEntry("pipeline-state", record)` 持久化，会话重启自动恢复。`findIncompleteByName()` 检测未完成流水线并断点续跑；配置了 `pi.memory` 时还会在 `memory://` 中保存兜底状态与等待中的 LLM 决策。

## 执行流程

```
/pipeline run <name> --vars ...
  │
  ├─ 加载 .omp/pipelines/<name>.json（回退 .pi/pipelines）
  ├─ 发现实体（entityDiscovery.pattern + exclude）
  ├─ 发现 Agent（user → project → skill，后者覆盖）
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
              ├─ 有 Agent → createAgentSession() 进程内执行
              │    ├─ 渲染 taskTemplate
              │    ├─ 流式日志 + trace + yield 摘要
              │    └─ versionOutputs
              ├─ 失败 → retry (maxRetries)
              ├─ validate bash 命令
              └─ resolveRoute → 下一阶段 / __LLM__ / done
```

## 安全

- 流水线定义中的 `validate`、`skipIf.bash`、`hooks` 会以当前用户权限执行 bash
- Agent 以 pi/omp 的工具权限（read/write/bash 等）运行
- 插件与普通扩展一样在进程内运行，可访问会话数据与文件系统

只运行你信任的流水线与 Agent 定义。漏洞报告方式见 [SECURITY.md](../../SECURITY.md)。

## 文件结构

```
pipeline-orchestrator/
├── index.ts          # 入口：注册命令、工具、executePipelineRun 主循环
├── pipeline.ts       # 执行引擎：createAgentSession、流式日志、validate、hooks
├── state.ts          # 状态引擎：持久化、路由解析、skipIf、模板渲染
├── agents.ts         # Agent 发现：解析 .md frontmatter、3 层优先级
├── types.ts          # 类型定义：PipelineDefinition、PhaseDefinition 等
├── pi-types.d.ts     # pi/omp 运行时类型桩（开发用，运行时注入真实实现）
├── package.json      # 插件元数据（omp.extensions + 旧版 pi.extensions）
├── .gitignore
└── README.md
```
