# Pipeline Orchestrator — 可观测性驱动的进化设计

> 基于 [Agentic Harness Engineering: Observability-Driven Automatic Evolution of Coding-Agent Harnesses](https://arxiv.org/abs/2604.25850v4)（Lin et al., 2026），对 pipeline-orchestrator 插件和 pipeline-setup skill 的改进设计。

---

## 1. 论文核心洞察

AHE 提出三个可观测性支柱，让 harness 进化自动化：

| 支柱 | 含义 | 论文关键数据 |
|------|------|------------|
| **Component Observability** | 7 种组件各自独立文件（prompt, tool, middleware, memory, skill, sub-agent） | 解耦后每次失败映射到单一组件，编辑可 git revert |
| **Experience Observability** | 原始 trajectory（~10M tokens）蒸馏为分层证据（~10K tokens） | Agent Debugger 让进化 Agent 消费结构化根因而非原始日志 |
| **Decision Observability** | 每次编辑附带自声明预测，下轮验证后确认或回滚 | 修正预测精度 33.7%（5x 随机基线），回归预测几乎瞎猜（11.8%） |

**关键实验发现**：

- **Tools + Middleware + Memory 承载增益，System Prompt 单独使用反退步**（Table 3）。Middleware = 控制执行和恢复的层（危险命令拦截、超时恢复、evaluator 后处理）。
- **组件增益非可加性**：独立增益 +11.1pp（memory +5.6, tool +3.3, middleware +2.2），堆叠仅得 +7.3pp。原因：多个组件验证边界重叠。**每个循环必须验证不同层次，否则叠加互相抵消。**
- **进化后 harness 跨 benchmark 和模型家族可迁移**（+5.1~+10.1pp）。

---

## 2. 两个任务场景

| | 短期（Skill 型） | 长期（工程迭代型） |
|---|---|---|
| **运行次数** | 1~3 次 | 几十到上百次 |
| **目标** | 产出正确结果 | 产出正确结果 + pipeline 本身持续变好 |
| **示例** | 卡片生成、报告转换、数据清洗 | 多 bug 修复、CI 流水线、SWE-bench 类任务 |
| **lifecycle** | `"oneshot"` | `"iterative"` |
| **数据结构** | PhaseSummary | PhaseSummary + ChangeManifest + Memory |
| **LLM 交互** | 失败 → 读 summary 修文件 → 重跑 | 失败 → 读 manifest → 改 pipeline → 验证 → 积累 |

### 2.1 长期任务示例：多 Bug 修复工程

```
Issue 收集（浏览 GitHub Issue，整理为待修改文档）
  │
  ▼
依赖分析 + 任务分块 ——→ 串行/并行图
  │
  ├─ Bug A (worktree-1) ──────────────────────────────┐
  │    ┌──────────────────────────────────────────┐   │
  │    │  调查循环 (research_loop, max 5):         │   │
  │    │  investigate → web_research → plan        │   │
  │    │     ↑________________________↓           │   │
  │    │        (资料不全/计划有误 → 回退)          │   │
  │    │                                           │   │
  │    │  修改循环 (code_loop, max 3):              │   │
  │    │  modify_code → review_code               │   │
  │    │     ↑__________________↓                 │   │
  │    │        (审查不过 → 回退)                  │   │
  │    │  → git commit worktree                   │   │
  │    └──────────────────────────────────────────┘   │
  │                                                    │
  ├─ Bug B (worktree-2) [依赖 Bug A] ────────────────  │
  ├─ Bug C (worktree-3) [依赖 Bug A] ────────────────  │  ← B、C 可并行
  │    ...同上...                                      │
  │                                                    │
  ▼                                                    │
（所有 worktree 完成 → LLM 合并到主分支 → 下一轮）       │
```

**关键结构**：

| 结构 | 当前支持 | 需要新增 |
|------|---------|---------|
| 调查循环 + 修改循环共用一个 `iter` | ❌ 共用一个计数器 | `loopId` + 独立计数 |
| Bug B 必须等 Bug A 完成 | ❌ concurrency 只管并行数 | `entityDependencies` |
| worktree 创建/删除 | ❌ 无 hook 点 | PhaseHooks |
| 调查摘要 → 修改者参考 | ❌ 改代码的 agent 看不到调查结果 | PhaseSummary + `{lastPhaseSummary}` |
| 跨 Bug 经验积累 | ❌ 无 | ChangeManifest + Memory |

---

## 3. 新增设计

### 3.1 `lifecycle`（Pipeline JSON 顶层字段）

```jsonc
{
  "name": "my-pipeline",
  "lifecycle": "oneshot"  // "oneshot" | "iterative"
}
```

| 值 | PhaseSummary | manifest.json | memory.json |
|----|-------------|---------------|-------------|
| `"oneshot"` | ✅ 生成 | ❌ 不创建 | ❌ 不创建 |
| `"iterative"` | ✅ 生成 | ✅ 初始化 | ✅ 初始化 |

一行字段，改动量最小。

### 3.2 PhaseSummary（EntityState 字段）

Agent 执行完一个 phase 后，自动从输出中提取结构化摘要，存入 entity 状态。LLM 随后读 entity 状态即可看到，无需 grep 原始日志。

```typescript
// types.ts — EntityState 新增
phaseSummaries: Record<string, PhaseSummary>;  // key = phase name

interface PhaseSummary {
  verdict: "PASS" | "FAIL" | "UNCLEAR";  // 从 outputContains/outputRegex 匹配提取
  keyFindings: string[];                  // 最多 3 条，匹配到的关键行
}
```

**生成逻辑**（`processEntity` 中，`resolveRoute` 后）：

```typescript
function buildPhaseSummary(output: string, phaseDef: PhaseDefinition): PhaseSummary {
  let verdict: PhaseSummary["verdict"] = "UNCLEAR";
  const findings: string[] = [];
  if ("routes" in phaseDef.transition) {
    for (const r of phaseDef.transition.routes) {
      if (r.if === true) continue;
      if (!r.if.outputContains) continue;
      if (output.includes(r.if.outputContains)) {
        if (/PASS/i.test(r.if.outputContains)) verdict = "PASS";
        else if (/NOT PASS|FAIL/i.test(r.if.outputContains)) verdict = "FAIL";
        findings.push(r.if.outputContains);
      }
    }
  }
  return { verdict, keyFindings: findings.slice(0, 3) };
}
```

**LLM 使用**：读 `state.getPipeline(id).entities["bug-A"].phaseSummaries["review_code"]` 直接获知 verdict 和关键发现。agent prompt 可通过 `{lastPhaseSummary.verdict}` 和 `{lastPhaseSummary.keyFindings}` 引用。

### 3.3 ChangeManifest（iterative 专用）

文件：`.pi/pipelines/{name}.manifest.json`

跟踪 pipeline.json 的每次修改及其结果。**不是自动化引擎，是 LLM 的跨轮记忆。** 对话截断后，LLM 读 manifest 就知道之前改了什么、哪些有效。

```typescript
interface ChangeManifest {
  rounds: ChangeRound[];
}

interface ChangeRound {
  round: number;
  timestamp: string;
  changes: ChangeEntry[];
}

interface ChangeEntry {
  target: string;                  // e.g. "phases[2].maxRetries"
  before: unknown;                 // 改动前的值
  after: unknown;                  // 改动后的值
  why: string;                     // 基于什么证据（对应论文 rationale）
  verdict: "kept" | "reverted" | null;
}
```

**为什么比论文简化**：

| 论文字段 | 简化理由 |
|----------|---------|
| `baseHash` | LLM 不算 hash，comparison 用 `before` 值即可 |
| `expectedFixes: string[]` | LLM 读 entity 状态就能知道哪些 entity 成功了，manifest 不重复 |
| `atRiskRegressions: string[]` | 论文自身数据显示回归预测几乎瞎猜（11.8% precision），记录它没有决策价值 |
| `runResult` 整个对象 | LLM 可以看 `pipeline status`，manifest 不重复运行时数据 |

保留的核心：**改了什么、为什么改、结果如何**。三个字段构成最小可证伪契约。

**LLM 交互**：
1. 改 pipeline.json → 在 manifest 追加 ChangeEntry（why="..."，verdict=null）
2. 跑 `/pipeline run` → LLM 对比结果，填入 verdict（"kept" 或 "reverted"）
3. 下一轮 → LLM 读 manifest，看到 prevRound "reverted" 的改动不再重复

### 3.4 Memory（iterative 专用）

文件：`.pi/pipelines/{name}.memory.json`

跨运行积累的经验。与 manifest 的区别：manifest 跟踪"某次 pipeline.json 改动是否有效"，memory 存储"哪种失败模式对应什么修复"，更偏领域知识。

```typescript
interface MemoryStore {
  lessons: Lesson[];
}

interface Lesson {
  pattern: string;        // 失败模式描述，e.g. "Agent 输出缺少 VERDICT 标记"
  rootCause: string;      // 根因，e.g. "prompt 中的 VERDICT 指令在超长输出后被截断"
  fix: string;            // 修复方式，e.g. "在 prompt 开头和结尾各写一次 VERDICT 要求"
  confirmedRuns: string[];  // 验证有效的 run ID
  regressionRuns: string[]; // 反效的 run ID
}
```

**论文映射**：论文 Memory 单独使用 +5.6pp（最大单组件增益），12 条边界经验每条解决一个具体失败模式。

### 3.5 嵌套循环：`loopId` + 独立计数

当前 `EntityState.iter` 是全局计数器。调查循环和修改循环共享同一个 iter，一个耗完另一个也死。

**改为**：

```typescript
// types.ts — EntityState
loopCounters: Record<string, number>;  // e.g. { "research_loop": 2, "code_loop": 1 }
```

Route 新增 `loopId` 字段：

```jsonc
// 调查循环回退
{ "if": { "outputContains": "PLAN: INCOMPLETE" },
  "next": "investigate", "iter": true, "loopId": "research_loop" }

// 修改循环回退
{ "if": { "outputContains": "REVIEW: FAIL" },
  "next": "modify_code", "iter": true, "loopId": "code_loop" }

// 无 loopId 的 iter 归入隐式循环 "__global__"
```

Pipeline JSON 新增 `maxIterationsPerLoop`，与现有 `maxIterations` 并列：

```jsonc
{
  "maxIterations": 5,                    // 全局上限（向后兼容，无 loopId 的路由用这个）
  "maxIterationsPerLoop": {              // 按循环上限（新增）
    "research_loop": 5,
    "code_loop": 3
  }
}
```

> **设计决定**：不用 `number | Record<string, number>` 联合类型。两个独立字段比联合类型清晰，无 loopId 时查 `maxIterations`，有 loopId 时优先查 `maxIterationsPerLoop[loopId]`，fallback 到 `maxIterations`。

**论文映射**：对应非可加性发现。调查循环验证计划层次，修改循环验证代码层次，各自独立计数，防止一个循环的迭代挤占另一个的预算。

### 3.6 实体依赖

```typescript
// PipelineDefinition
entityDependencies?: Record<string, string[]>;
// e.g. { "bug-B": ["bug-A"], "bug-C": ["bug-A"], "bug-D": ["bug-B", "bug-C"] }
```

**含义**：key 依赖 value 中所有 entity 完成（AND 语义）。无需 OR 语义（当前场景不存在）。

**执行逻辑**（`processEntity` 开始处，`skipIf` 之前）：

```typescript
const deps = def.entityDependencies?.[entityId];
if (deps?.length) {
  // 轮询等待依赖完成
  while (true) {
    const states = deps.map(d => state.getPipeline(pid)?.entities[d]);
    if (states.every(s => s && ["completed","failed","skipped"].includes(s.status))) break;
    await sleep(2000);
  }
  // 依赖中有失败的 → 当前 entity 跳过
  if (deps.some(d => state.getPipeline(pid)?.entities[d]?.status === "failed")) {
    state.updateEntity(..., { status: "skipped", error: "Dependency failed" });
    return;
  }
}
```

- 被阻塞的 entity **不占用并发槽位**（依赖检查在 sem.acquire 之前）
- `concurrency` 照常控制就绪 entity 的并行数
- 不需要 `type: "serial"|"parallel"` 字段——被依赖的 entity 之间的串行/并行由 concurrency 自然控制

### 3.7 PhaseHooks（Middleware 雏形）

PhaseDefinition 新增 `hooks` 字段：

```typescript
interface PhaseHooks {
  before?: string;   // bash 命令，Agent spawn 前执行，exit 非 0 跳过此阶段
  after?:  string;   // bash 命令，Agent 退出后、validate 前执行，exit 非 0 触发重试
}
```

**为什么是字符串不是 `{ bash: string }` 嵌套对象**：只有一个 action 类型（bash），嵌套无意义。

**执行顺序**：

```
skipIf → hooks.before → Agent spawn → hooks.after → validate → PhaseSummary → resolveRoute
```

**示例（worktree 管理）**：

```jsonc
{
  "name": "investigate",
  "agent": "investigator",
  "hooks": {
    "before": "git -C {repo_dir} worktree add ../worktree-{entity} main",
    "after":  "git -C {repo_dir} worktree remove ../worktree-{entity} --force 2>/dev/null; true"
  }
}
```

**论文映射**：论文 Middleware 单独使用 +2.2pp。我们的 `skipIf`、`validate`、`timeoutMinutes`、`maxRetries` 已经是 middleware 雏形。hooks 补上 Agent 执行前后的通用 hook 点。论文有 7 种组件需要独立文件管理，我们只有 agent + phase，hooks 作为 phase 附属字段足够。

---

## 4. 明确不做的事

以下是在设计中**刻意移除**的特性及原因：

| 移除项 | 原因 |
|--------|------|
| `checkpoints` 字段 | LLM 对话里就能 merge。用 skipIf + validate 的常规 phase 可实现合并检查（skipIf 保证只执行一次） |
| `entityDependencies[].type` | `requires` 数组本身表达依赖，被依赖 entity 间的串行/并行由 `concurrency` 控制 |
| ChangeEntry 的 `expectedFixes` / `atRiskRegressions` 数组 | LLM 读 entity 状态就能判断；论文数据显示回归预测精度仅 11.8%，记录它无决策价值 |
| ChangeEntry 的 `baseHash` | LLM 不算哈希，用 `before` 值做 diff 更实用 |
| ChangeEntry 的 `runResult` 对象 | 运行时数据已在 entity 状态中，不重复 |
| Memory 的 `componentAffected` 枚举 | 约束 LLM 记录经验的自然表达；LLM 可在 `pattern` 文字中自然描述涉及的组件 |
| PhaseHooks 的 `{ before: { bash } }` 嵌套 | 只有 bash 一种 action，嵌套无意义 |
| `maxIterations` 的 `number \| Record` 联合类型 | 两个独立字段（`maxIterations` + `maxIterationsPerLoop`）比联合类型清晰 |
| `pipeline_diagnose` 等新命令 | LLM 直接读数据结构，不需要包装成命令 | 
| pipeline-setup 自动推断嵌套循环 | 应询问用户确认，不应自动猜 |

---

## 5. 插件改动（pipeline-orchestrator）

### 5.1 types.ts — 新增类型

```typescript
// ── lifecycle ──
// PipelineDefinition 新增
lifecycle?: "oneshot" | "iterative";

// ── PhaseSummary ──
interface PhaseSummary {
  verdict: "PASS" | "FAIL" | "UNCLEAR";
  keyFindings: string[];
}
// EntityState 新增
phaseSummaries: Record<string, PhaseSummary>;

// ── ChangeManifest ──
interface ChangeManifest {
  rounds: ChangeRound[];
}
interface ChangeRound {
  round: number;
  timestamp: string;
  changes: ChangeEntry[];
}
interface ChangeEntry {
  target: string;
  before: unknown;
  after: unknown;
  why: string;
  verdict: "kept" | "reverted" | null;
}

// ── Memory ──
interface MemoryStore {
  lessons: Lesson[];
}
interface Lesson {
  pattern: string;
  rootCause: string;
  fix: string;
  confirmedRuns: string[];
  regressionRuns: string[];
}

// ── 嵌套循环 ──
// EntityState 新增
loopCounters: Record<string, number>;
// Route 新增
loopId?: string;
// PipelineDefinition 新增
maxIterationsPerLoop?: Record<string, number>;

// ── 实体依赖 ──
// PipelineDefinition 新增
entityDependencies?: Record<string, string[]>;

// ── PhaseHooks ──
interface PhaseHooks {
  before?: string;
  after?:  string;
}
// PhaseDefinition 新增
hooks?: PhaseHooks;
```

### 5.2 index.ts — 改动点

**autoLoadDefinitions**：

```typescript
// 加载 pipeline JSON 后
if (def.lifecycle === "iterative") {
  state.loadManifest(def.name);
  state.loadMemory(def.name);
}
```

**processEntity — 完整执行顺序**：

```
processEntity(entityId):
  1. 取消/停止检查
  2. 实体依赖检查（entityDependencies）         ← 新增
     → 依赖未满足：不获取信号量，轮询等待（2s 间隔）
     → 依赖失败：跳过当前 entity
  3. sem.acquire()
  4. skipIf
  5. hooks.before                                ← 新增
  6. Agent spawn（现有 executePhase）
  7. hooks.after                                 ← 新增
  8. validate（现有 runValidation）
  9. PhaseSummary 生成                           ← 新增
  10. resolveRoute（现有，支持 loopId）           ← 扩展
  11. 路由决策：
      - iter: true → 按 loopId 独立计数          ← 改动
      - __LLM__/__COND__/__MANUAL__ → 暂停
      - 阶段名 → 更新 phase
  12. 检查 maxIterations/maxIterationsPerLoop    ← 改动
```

**嵌套循环计数**（替换现有 `entity.iter` 逻辑）：

```typescript
if (route.iter) {
  const lid = route.loopId || "__global__";
  const counters = { ...entity.loopCounters };
  counters[lid] = (counters[lid] || 0) + 1;

  const maxIter = def.maxIterationsPerLoop?.[lid]
    ?? maxIterationsPerLoop?.["__global__"]
    ?? def.maxIterations
    ?? DEFAULT_MAX_ITER;

  if (counters[lid] >= maxIter) {
    state.updateEntity(..., { status: "failed", error: `Max iterations for ${lid}` });
    return;
  }
  state.updateEntity(..., { loopCounters: counters });
}
```

**PhaseSummary 生成**：

```typescript
// resolveRoute 之后、状态更新之前
const summary = buildPhaseSummary(result.output ?? "", phaseDef);
state.updateEntity(..., { phaseSummaries: { ...entity.phaseSummaries, [currentBase]: summary } });
```

### 5.3 state.ts — 新增方法

```typescript
// Manifest
loadManifest(name: string): ChangeManifest | null;
saveManifest(name: string, m: ChangeManifest): void;

// Memory
loadMemory(name: string): MemoryStore | null;
saveMemory(name: string, m: MemoryStore): void;

// 迭代计数
getLoopCounter(e: EntityState, loopId: string): number;

// 依赖
areDependenciesMet(pid: string, eid: string): boolean;
```

持久化方式：manifest 和 memory 使用 `pi.appendEntry("pipeline-manifest", ...)` 或直接写 `.pi/pipelines/{name}.manifest.json`（与 pipeline-state 同层）。

### 5.4 pipeline.ts — 改动点

**PhaseHooks 执行**（`executePhase` 调用前/后）：

```typescript
// hooks.before
if (phase.hooks?.before) {
  const cmd = substituteVars(phase.hooks.before, vars);
  const r = spawnSync("bash", ["-c", cmd], { cwd, timeout: 30000 });
  if (r.status !== 0) return { exitCode: 0, output: "", stderr: "", error: "hooks.before failed" };
}

// hooks.after（在 validate 之前）
if (phase.hooks?.after) {
  const cmd = substituteVars(phase.hooks.after, vars);
  const r = spawnSync("bash", ["-c", cmd], { cwd, timeout: 30000 });
  if (r.status !== 0) {
    // after 失败 → 触发重试
    result.exitCode = 1;
    result.error = "hooks.after failed";
  }
}
```

### 5.5 `{lastPhaseSummary}` 模板变量

`renderTaskTemplate` 新增变量：

```
{lastPhaseSummary.verdict}      → "PASS" | "FAIL" | "UNCLEAR"
{lastPhaseSummary.keyFindings}  → 换行分隔的关键发现
```

让下一个 phase 的 agent 能读取上一个 phase 的结构化摘要，避免每个 agent 各自翻原始日志。对应论文 Experience Observability。

### 5.6 `/pipeline status` 增强

iterative 模式输出增加阶段级成功率和循环计数：

```
Pipeline: bug-fix  [3/10]  iterative  Round 2
─────────────────────────────────────────────────
bug-A  ✅ done     research: 2/5  code: 1/3
bug-B  ▶ modify   research: 3/5  code: 1/3
bug-C  ⏳ dep:A   —
─────────────────────────────────────────────────
Phase      Pass
investigate  80%  ← 瓶颈
web_research 80%
plan         80%
modify_code  60%
review_code  40%
done         20%
```

---

## 6. pipeline-setup skill 改动

### 6.1 决策 lifecycle

检测 SKILL.md 关键词：

```
oneshot:  "生成"/"转换"/"一次性"/"报告"/"卡片" 或 明确 "Phase 1/2/3" 序列
iterative: "迭代"/"持续改进"/"修复"/"bug"/"issue"/"worktree"/"多轮"

未命中 → 预览中询问用户
```

### 6.2 交互式预览

生成 pipeline.json 后**不直接写入**，先输出预览。用户可确认或逐项调整：

```
我推断了以下配置：

  📋 任务类型: 短期 (lifecycle = "oneshot")
  🔄 4 个阶段: generated → reviewed → classified → done
  🔁 reviewed 阶段: PASS/NOT PASS 自动循环 (max 5)

确认生成？或：
  - 改为长期迭代模式
  - 调整循环上限
  - 让我编辑 JSON
```

iterative 场景预览增加循环上限和依赖确认：

```
  📋 任务类型: 长期迭代 (lifecycle = "iterative")
     → 将创建 manifest.json 和 memory.json

  🔄 两个独立循环:
     调查循环 investigate ⇄ plan  max 5 次
     修改循环 modify_code ⇄ review  max 3 次

  🔗 依赖: bug-B 等 bug-A, bug-C 等 bug-A

  ⚙️ hooks: investigate 阶段含 worktree 创建/删除

确认？或：
  - 调整调查循环上限
  - 调整修改循环上限
  - 修改依赖关系
  - 让我编辑 JSON
```

### 6.3 嵌套循环推断

SKILL.md 中有多个回退箭头时，pipeline-setup 生成多个 `loopId` 和对应的 `maxIterationsPerLoop` 条目。但**不自动命名 loopId**——询问用户每个循环的含义后命名。

### 6.4 依赖推断

SKILL.md 中的依赖描述（"Bug B 依赖 Bug A"、"Bug A 完成后才能开始 Bug C"）提取为 `entityDependencies`。未检测到时字段不生成。

### 6.5 iterative 初始化

```bash
write .pi/pipelines/{name}.manifest.json  # { "rounds": [] }
write .pi/pipelines/{name}.memory.json    # { "lessons": [] }
```

---

## 7. 论文发现与设计决策映射

| 论文发现 | 设计决策 |
|----------|---------|
| Component Observability：组件解耦为文件 | agents/*.md + pipeline.json 已是独立文件（已有） |
| Experience Observability：轨迹蒸馏 | PhaseSummary + `{lastPhaseSummary}` 模板变量（3.2, 5.5） |
| Decision Observability：编辑→预测→验证→回滚 | ChangeManifest：改了什么、为什么、结果如何（3.3） |
| Memory 最大单组件增益 +5.6pp | Memory 跨运行积累（3.4） |
| Middleware 第二增益源 +2.2pp | PhaseHooks before/after（3.7），不抽象为独立组件 |
| 组件增益非可加性 +11.1→+7.3pp | 嵌套循环按层次独立计数（3.5），防止同层验证互相抵消 |
| System Prompt 单独使用反退步 -2.3pp | pipeline-setup 预览时提示：不要把所有逻辑塞进 agent prompt |
| 修正预测精度 33.7%（5x 随机） | ChangeEntry.why + verdict：LLM 自己归因，保留有效改动 |
| 回归预测盲目 11.8% | 不存储 atRiskRegressions（无价值），但保留 why 字段让 LLM 事后对照 |
| Agent Debugger 做分层蒸馏 | PhaseSummary 是第一层蒸馏，explorer agent 的 summary 是第二层 |

---

## 8. 实现顺序

| # | 改动 | 文件 | 理由 |
|---|------|------|------|
| 1 | `lifecycle` 字段 | types.ts, index.ts, state.ts | 一行改动激活两套行为 |
| 2 | PhaseSummary 类型 + 生成 | types.ts, index.ts, pipeline.ts | 短期+长期共用 |
| 3 | `{lastPhaseSummary}` 模板变量 | state.ts `renderTaskTemplate` | agent 可消费结构化摘要 |
| 4 | `maxIterationsPerLoop` + `loopId` | types.ts, index.ts, state.ts | 嵌套循环基础 |
| 5 | `loopCounters` 替代 `iter` | types.ts, index.ts, state.ts | 嵌套循环计数逻辑 |
| 6 | PhaseHooks before/after | types.ts, index.ts, pipeline.ts | middleware 雏形 |
| 7 | ChangeManifest 类型 + load/save | types.ts, state.ts | iterative 生存周期 |
| 8 | Memory 类型 + load/save | types.ts, state.ts | 长期积累 |
| 9 | entityDependencies | types.ts, index.ts, state.ts | 依赖图 |
| 10 | pipeline-setup 交互式预览 + 推断 | pipeline-setup SKILL.md | 用户可见改进 |
| 11 | `/pipeline status` 增强 | index.ts | 运行监控 |

---

## 9. TODO

### ✅ 已完成

### 🔲 待实施

- [x] **1. `lifecycle` 字段** — types.ts 新增 `lifecycle?: "oneshot" | "iterative"`，index.ts `autoLoadDefinitions` 按 lifecycle 条件加载 manifest/memory
- [x] **2. PhaseSummary 类型 + 生成** — types.ts 新增 `PhaseSummary` 接口和 `EntityState.phaseSummaries`，index.ts `processEntity` 中 agent 输出后调用 `buildPhaseSummary`
- [x] **3. `{lastPhaseSummary}` 模板变量** — state.ts `renderTaskTemplate` 新增 `{lastPhaseSummary.verdict}` 和 `{lastPhaseSummary.keyFindings}`
- [x] **4. `maxIterationsPerLoop` + `loopId`** — types.ts 新增 `maxIterationsPerLoop?: Record<string, number>` 和 `Route.loopId?: string`
- [x] **5. `loopCounters` 替代 `iter`** — types.ts `EntityState.loopCounters: Record<string, number>`，index.ts 替换现有 `entity.iter` 逻辑为按 loopId 独立计数
- [x] **6. PhaseHooks before/after** — types.ts `PhaseHooks` 接口 + `PhaseDefinition.hooks`，pipeline.ts `executePhase` 前后执行 hooks
- [x] **7. ChangeManifest 类型 + load/save** — types.ts 新增 `ChangeManifest`/`ChangeRound`/`ChangeEntry`，state.ts 新增 `loadManifest`/`saveManifest`
- [x] **8. Memory 类型 + load/save** — types.ts 新增 `MemoryStore`/`Lesson`，state.ts 新增 `loadMemory`/`saveMemory`
- [x] **9. entityDependencies** — types.ts `PipelineDefinition.entityDependencies`，index.ts `processEntity` 开始处依赖检查
- [x] **10. pipeline-setup 交互式预览** — pipeline-setup SKILL.md 新增 lifecycle 决策、预览流程、iterative 初始化
- [x] **11. `/pipeline status` 增强** — index.ts status handler 输出阶段级成功率和 loopCounters
- [x] **12. 同步到运行时** — rsync 插件到 `~/.pi/agent/extensions/pipeline-orchestrator/`，pipeline-setup 到 `~/.pi/agent/skills/pipeline-setup/`
