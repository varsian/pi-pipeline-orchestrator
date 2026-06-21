---
name: pipeline-setup
description: Read existing skill definitions (agents, pipeline structure) and auto-configure them for the pipeline-orchestrator plugin. Installs agent files, registers pipeline definitions, and makes skills ready for pipeline execution. Triggers on "配置流水线", "setup pipeline", "安装pipeline", "deploy agents", "/pipeline-setup".
---

# Pipeline Setup

读取任意 pipeline-compatible skill，自动提取 agent 和流水线结构，安装到项目下供 pipeline-orchestrator 插件使用。

## Skill 发现

用户说"配置 XXX 的流水线"时，按顺序查找 skill：

1. `{cwd}/{name}/` — 当前目录
2. `{cwd}/.omp/skills/{name}/` 或 `{cwd}/.pi/skills/{name}/` — 项目 skill
3. `~/.omp/agent/skills/{name}/` 或 `~/.pi/agent/skills/{name}/` — 全局 skill
4. 都不存在 → 中断，提示 `No skill named "{name}" found.`

找到后所有路径基于该 skill 目录解析。

## 做什么

1. 安装 `{skill}/agents/*.md` → `.pi/agents/`（也写入 `.omp/agents/` 如果存在）
2. 解析 `{skill}/SKILL.md` 的流水线描述 → `.pi/pipelines/{name}.json`
3. **交互式预览**：生成后不直接写入，先展示关键决策让用户确认或调整
4. **验证**：保存后用 `/pipeline validate {name}` 检验配置正确性
5. 输出配置摘要

## Lifecycle

所有 pipeline 均为单次批处理模式。每个阶段按定义顺序执行，路由表控制循环与条件跳转。无需 manifest.json 或 memory.json 等附加文件。

---

## Step 1: 读取 skill 结构

```
1. 确认 {skill}/agents/ 存在且含 ≥1 个 .md
2. 读取每个 agent .md 的 YAML frontmatter (name, description, tools)
3. 读取 {skill}/SKILL.md，提取:
   - 流水线名称 → pipeline name（默认用 skill 目录名）
   - 输入路径模式 → entityDiscovery.pattern
   - 输出路径模式 → outputDir
   - 用户变量名（$XXX 风格）→ variables
   - 阶段列表和顺序 → phases
   - 每阶段的 agent 映射 → phases[].agent
   - 循环/回退描述 → routes with iter
   - 模型判断描述（"PASS/NOT PASS"、"合格/不合格"）→ outputContains 路由
   - LLM 介入点 → __LLM__ / llm type
   - 终态 → __MANUAL__ / done
   - 校验命令 → phases[].validate
   - 跳过条件 → skipIf
   - 迭代限制 → maxIterations
   - 嵌套循环描述 → maxIterationsPerLoop + loopId（多个回退箭头时各自独立命名）
   - 实体依赖描述 → entityDependencies（"A 依赖 B"、"B 完成后才能开始 C"）
   - worktree/环境操作 → hooks（before/after bash 命令）
   - 超时提示 → timeoutMinutes
```

## Step 2: 安装 agent

```bash
cp {skill}/agents/*.md .pi/agents/
```

已存在同名文件时 diff 对比，提示覆盖。

## Step 3: 生成 pipeline JSON

### 基础字段

| 来源 | JSON 字段 | 说明 |
|:--|:--|:--|
| skill 目录名 | `name` | 去掉空格和特殊字符 |
| SKILL.md 描述的实体类型 | `entityType` | 如"topics"、"modules"、"repos" |
| SKILL.md 的 `$VAR/path/` 模式 | `entityDiscovery.pattern` | 替换 `$VAR` 为 `{var_name}` |
| SKILL.md 的输出路径 | `outputDir` | 占位符换 `{pipelineId}` 和 `{entity}` |
| "循环 N 次" / "最多回退 N 次" | `maxIterations` | 默认 5 |
| 用户变量名列表 | `variables` | 默认值留空，`skill_dir` 填绝对路径 |

### 阶段推断

从 SKILL.md 流水线描述（文字或 ASCII 图）提取阶段序列。

识别模式:
  `"Phase 1: XXX"` / `"阶段一: XXX"` → 阶段名
  `"A → B → C"`                    → 顺序提取 A, B, C
  `"[agent: name]"`                 → phases[].agent

如果 SKILL.md 无明确流水线描述，进入**手动模式**（见后）。

---

### ⚠️ 占位符翻译（必须在保存前执行）

route 示例中使用的 `__NEXT__`、`__SELF__`、`__LLM__` 是**写作占位符**，
保存到 `.pi/pipelines/{name}.json` **之前必须翻译**：

| 占位符 | 翻译规则 | 示例 |
|:--|:--|:--|
| `__NEXT__` | → phases 数组中**紧接下一阶段**的 name | `"__NEXT__"` → `"quality_reviewed"` |
| `__SELF__` | → **当前阶段**的 name（实现循环） | `"__SELF__"` → `"quality_reviewed"` |
| `__LLM__` | **不翻译**——这是插件识别的特殊标记 | 保持原样 |
| `"done"` | **不翻译**——终态标记 | 保持原样 |

**检查清单**（保存前逐项确认）：
- [ ] 所有 route `next` 字段不含 `__NEXT__`
- [ ] 所有 route `next` 字段不含 `__SELF__`
- [ ] `__LLM__` 正确保留

### ⚠️ taskTemplate 格式（必须用对象）

taskTemplate **必须是对象**，不是字符串：

```json
// ✅ 正确
{
  "taskTemplate": {
    "template": "为物理主题「{entity}」生成 Anki 卡片...",
    "variables": {}
  }
}

// ❌ 错误——插件会崩溃
{
  "taskTemplate": "为物理主题「{entity}」生成 Anki 卡片..."
}
```

`template` 字段从 SKILL.md 中描述的每个阶段的 agent 任务复制，
将具体主题/文件名替换为 `{entity}`，用户变量 `$XXX` → `{xxx}`（小写）。

### ⚠️ entityDiscovery.pattern（不能包含 {entity}）

entityDiscovery 的作用是**发现实体列表**（扫描目录找子目录/文件作为实体）。
因此 pattern 必须解析到一个**包含实体子目录的父目录**，
**不能**在 pattern 中写 `{entity}`。

```
✅ {study_dir}/phy/questions/      → 扫描问题目录，发现"万有引力与宇宙航行"等
❌ {study_dir}/phy/questions/{entity}/  → {entity} 是运行时变量，发现阶段不替换
```

### ⚠️ skill_dir 变量（必须设为绝对路径）

所有 phase 的 taskTemplate、validate 可能引用 `{skill_dir}`（skill 的 references/、scripts/）。
必须在 `variables` 中定义：

```json
{
  "variables": {
    "study_dir": { "description": "...", "default": "" },
    "skill_dir": { "description": "...", "default": "/home/user/.pi/agent/skills/my-skill/" }
  }
}
```

**注意**: `default` 填 skill 目录的**绝对路径**（用 `pwd` 或 `realpath` 获取），
不是相对路径。用户运行时可通过 `--vars` 覆盖。

### ⚠️ 禁止使用 conditional 类型

`conditional` 类型已废弃。需要 LLM 裁决的阶段用：

```json
// ✅ llm 类型
{ "type": "llm", "prompt": "审查日志后决定 pass/loop..." }

// 或 routes + __LLM__
{ "routes": [
    { "if": { "outputContains": "VERDICT: PASS" }, "next": "done" },
    { "if": true, "next": "__LLM__", "prompt": "..." }
]}

// ❌ conditional——已废弃
{ "type": "conditional", "pass": "X", "loop": "Y" }
```

---

### 决策模式概述

pipeline-orchestrator 支持两种决策方式，在配置 SKILL.md 或生成 pipeline JSON 时选择：

| 模式 | 配置 | 决策者 | 适用场景 |
|:--|:--|:--|:--|
| **子 Agent 决策** | `outputContains` + `iter: true` | 上一阶段 Agent 输出标记 | 判断标准可编码为 prompt（如 `VERDICT: PASS` / `VERDICT: NOT PASS`） |
| **LLM 决策** | `"__LLM__"` + `prompt` 或旧 `"type": "llm"` | 当前窗口 LLM 调 `pipeline_decide()` | 需要灵活判断、读文件、手动修复后推进 |

**子 Agent 决策**是推荐方式——管道全自动运行，无需人工介入。Agent prompt 末尾要求输出决策标记，route table 用 `outputContains` 匹配后自动推进。`iter: true` 的路由消耗一次迭代，`maxIterations` 控制循环上限。

**LLM 决策**用于无法提前编码判断逻辑的场景。管道暂停、释放并发槽位、注入 prompt 到当前对话。LLM 读文件、修内容、最后调 `pipeline_decide()` 恢复。

> 详细机制见 pipeline-orchestrator 插件 README 的「决策模式」章节。

### Transition 推断（路由表生成）

**默认**：线性推进，加入 fallback LLM（注意：以下示例用 `"nextPhase"` 表示替换后的实际名称）：

```json
{ "routes": [
    { "if": { "exitCode": 0, "validatePassed": true }, "next": "<下一阶段的实际名称>" },
    { "if": true, "next": "__LLM__", "prompt": "Phase failed. Review logs and decide." }
]}
```

**模型判断 + 循环**（`__SELF__` 必须替换为当前阶段名，多个循环各自用不同 `loopId`）：

```json
// 单循环（无 loopId，归入 __global__）
{ "routes": [
    { "if": { "outputContains": "VERDICT: PASS", "validatePassed": true }, "next": "<下一阶段的实际名称>" },
    { "if": { "outputContains": "VERDICT: NOT PASS" }, "next": "<当前阶段的实际名称>", "iter": true },
    { "if": true, "next": "__LLM__" }
]}

// 嵌套循环（各自 loopId + 独立上限）
// 调查循环
{ "if": { "outputContains": "PLAN: INCOMPLETE" }, "next": "investigate", "iter": true, "loopId": "research_loop" }
// 修改循环
{ "if": { "outputContains": "CODE: REJECT" }, "next": "modify_code", "iter": true, "loopId": "code_loop" }
```

对应的 pipeline JSON 顶层：

```json
{
  "maxIterations": 5,
  "maxIterationsPerLoop": {
    "research_loop": 5,
    "code_loop": 3
  }
}
```

**LLM 裁决**：SKILL.md 有 "人工审查" / "LLM 介入" 描述 → 用 `llm` 类型：

```json
{ "type": "llm", "prompt": "..." }
```

**终态**：最后一个阶段 → `next: "done"`（或 `__MANUAL__`）

### entityDependencies 生成

SKILL.md 中有 "A 依赖 B" / "B 完成后才能 C" 等描述时，生成：

```json
{ "entityDependencies": { "bug-B": ["bug-A"], "bug-C": ["bug-A"] } }
```

### hooks 生成

SKILL.md 中有 "创建 worktree" / "切换分支" / "git commit" 等操作描述时，对应 phase 生成 hooks：

```json
{
  "hooks": {
    "before": "git worktree add ../worktree-{entity} main",
    "after": "git worktree remove ../worktree-{entity} --force 2>/dev/null; true"
  }
}
```

### taskTemplate 生成

- 从 agent .md 的 body 提取核心指令
- 将具体主题/文件名替换为 `{entity}`
- 用户变量 `$XXX` → `{xxx}`（小写）
- 引用文件路径 → `{skill_dir}/references/...`

### validate 生成

从 SKILL.md 提取校验命令，变量名改写：
- `$STUDY` → `{study_dir}`
- 输出路径 → `{outputDir}`（插件会替换）

### skipIf 生成

"没数据跳过" / "目录不存在跳过" → `skipIf.bash`：

```json
{ "skipIf": { "bash": "ls {outputDir}/input/ 2>/dev/null | grep -q . || exit 0" } }
```

### versionOutputs

Agent prompt 中 "输出到 XXX.md" → `versionOutputs: ["XXX.md"]`

## Step 4: 交互式预览（必须先展示再写入）

**生成 pipeline JSON 后不直接写入文件**。先展示关键决策，让用户确认或逐项调整。

### oneshot 预览模板

```
我推断了以下配置：

  📋 任务类型: 单次批处理
  🔄 N 个阶段: phaseA → phaseB → ... → done
  🔁 phaseX 阶段: Agent 输出 PASS/NOT PASS 自动循环 (max 5 次)
  🛑 phaseY 阶段: 暂停等 LLM 决策

确认生成？或需要调整：
  - 改 phaseY 为自动 (Agent 输出标记 → outputContains)
  - 调整循环上限
  - 让我直接编辑 JSON
```

### 预览要点


- **列出推断出的循环**：每个回退箭头对应一个 loopId，上限默认 5
- **列出推断出的依赖**：从 "A 依赖 B" 等描述提取
- **列出 hooks**：从 "创建 worktree"/"切换分支"/"git commit" 等描述推断
- **嵌套循环命名**：不自动命名 loopId，在预览中询问用户含义后命名（如"research_loop"、"code_loop"）

用户确认后才执行 Step 5 写入。

## Step 5: 保存 + 验证

```bash
# 写入项目
write .pi/pipelines/{name}.json

# 关键：skill_dir 填绝对路径
variables.skill_dir = {skill 目录的绝对路径}
```

### 保存后必须验证

保存 pipeline JSON 后，在插件加载的项目中运行：
```
/pipeline validate {name}
```
插件内置校验器自动检查 10+ 项约束（entityDiscovery、taskTemplate 格式、占位符翻译、transition 合法性、maxIterations、废弃 conditional 类型等）。exit 0=通过，有错误则列出具体问题。**不再需要外部 validate_pipeline.py 脚本。**

---


## 输出契约（内置）

插件自动在每个阶段的 Agent prompt 末尾注入输出格式要求：

```
VERDICT: <PASS | FAIL | UNCLEAR>
SUMMARY: <one-line summary>
FINDINGS:
- <key finding>
```

路由表的 `outputContains: "VERDICT: PASS"` 依赖此格式。无需手动配置。

## 可视化

配置完成后可通过 `/pipeline graph {name}` 查看 Mermaid 流程图，直观展示阶段顺序、路由条件、循环边。

## 模板变量（含复用支持）

| 变量 | 含义 |
|:--|:--|
| `{entity}` | 当前实体 ID |
| `{outputDir}` | 输出目录（**可通过 `--vars outputDir=...` 覆盖**，实现同流程换任务） |
| `{lastOutput}` | 上一阶段输出全文 |
| `{lastPhaseSummary.verdict}` | 上一阶段结构化摘要 |
| `{自定义变量}` | 来自 `variables` 或 `--vars` |
## 路由表语法速查

### 条件类型

| 条件 | 类型 | 示例 |
|:--|:--|:--|
| `exitCode` | `number` | `0` |
| `validatePassed` | `boolean` | `true` |
| `outputContains` | `string` | `"VERDICT: PASS"` |
| `outputRegex` + `captureOp` | `string` + `{op,value}` | `"错误数: (\\d+)"`, `{"op":"lt","value":3}` |
| `fileExists` | `string` | `"{outputDir}/report.md"` |
| `fileMinSize` / `fileMaxSize` | `{path,bytes}` | `{"path":"...","bytes":4096}` |
| `bash` | `string` | `"grep -q PASS {output}"` |
| `true` | — | 兜底路由 |

### 可用的 route next 值

| 值 | 何时使用 | 是否需要翻译 |
|:--|:--|:--|
| 实际阶段名（如 `"quality_reviewed"`） | 线性前进到下一阶段 | **已翻译** |
| 当前阶段名 + `"iter": true` | 循环回当前阶段 | **已翻译** |
| `"__LLM__"` | 暂停等 `pipeline_decide` | 不翻译 |
| `"done"` | 终态 | 不翻译 |

### 旧格式（向后兼容）

```json
{ "type": "auto" }        // 线性
{ "type": "llm", "prompt": "..." }  // LLM 裁决
{ "type": "conditional", "pass": "X", "loop": "Y" }
{ "type": "manual" }
```

### Phase 附加字段

| 字段 | 说明 |
|:--|:--|
| `skipIf` | `{bash, fileExists, fileNotExists}` |
| `skipReason` | 跳过日志 |
| `versionOutputs` | `["file.md"]` — 自动加 `{iter}-` 前缀 |
| `timeoutMinutes` | 默认 30 |
| `hooks` | `{ before: "...", after: "..." }` — Agent spawn 前后 bash |

### 模板变量

| 变量 | 含义 |
|:--|:--|
| `{entity}` | 当前实体 ID |
| `{pipelineId}` | 实例 ID |
| `{iter}` / `{iterPrev}` | 迭代计数（从 1 开始） |
| `{lastOutput}` | 上一阶段输出全文 |
| `{output}` / `{output:phase}` | agent 日志路径 |
| `{outputDir}` | 输出目录 |
| `{outputDirFiles}` | ls 文件列表 |
| `{lastPhaseSummary.verdict}` | 上一阶段结构化摘要：PASS/FAIL/UNCLEAR |
| `{lastPhaseSummary.keyFindings}` | 上一阶段关键发现（换行分隔） |

---

## 示例：my-skill

```
输入: "配置 my-skill 的流水线"
发现: ~/.pi/agent/skills/my-skill/
Agents: 3 个 (generator, reviewer, classifier)
SKILL.md: 4 阶段，2 个模型判断循环，1 个 LLM 裁决

输出:
  ✓ 3 agents → .pi/agents/
  ✓ pipeline → .pi/pipelines/my-skill.json
    阶段: pending → generated ⇄ reviewed ⇄ classified → done
    skipIf: 输出目录无输入文件时跳过
    maxIterations: 5

  运行: /pipeline run my-skill --vars work_dir=/path/to/data
```

---

## 手动模式

如果 SKILL.md 无明确流水线描述：

1. 列出 `{skill}/agents/` 下的 agent 文件
2. 逐个询问：阶段名、agent 映射、是否循环、校验命令
3. 按用户回答生成 pipeline JSON

---

## ⛔ 常见错误（绝对不要犯）

| 错误 | 后果 | 正确做法 |
|:--|:--|:--|
| route next 留 `"__NEXT__"` 字面值 | 插件不认识，路由失败 | 替换为实际阶段名 |
| route next 留 `"__SELF__"` 字面值 | 同上 | 替换为当前阶段名 + `"iter": true` |
| taskTemplate 写成字符串 | `renderTaskTemplate` 崩溃 | 写成 `{"template": "...", "variables": {}}` |
| entityDiscovery 含 `{entity}` | 发现 0 个实体 | 只写到父目录 |
| 使用 conditional type | 插件不识别 | 用 `"type": "llm"` 或 routes |
| skill_dir 用相对路径 | validate 找不到脚本 | 填绝对路径 |
| `input_path`/`output_path` 包含 `$VAR` | 变量不会被替换 | 改写为 `{var_name}` 模板 |
| 阶段名含空格或特殊字符 | 文件路径问题 | 用下划线或驼峰 |

> **验证建议**：保存 pipeline JSON 后立即运行 `/pipeline validate {name}`，一步检测以上所有错误。
