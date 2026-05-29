# RFC: `batch` 作为模型包装器的并行工具执行

Status: Proposed

Owner: OpenCode

Last Updated: 2026-05-28

Audience: 人类维护者、coding agent

## 1. 背景

当前项目已经具备稳定的 agent durable 主链路：

```text
Composer
  -> SessionInteractionService.prompt()
  -> Lifecycle.startPromptRun()
  -> RunLoop.run()
  -> SessionProcessor.processTurn()
  -> persist ToolPart + ToolCall
  -> ToolExecutor.executePendingToolParts()
  -> 下一轮模型调用
```

对应实现见：

1. `packages/agent/src/session-processor.ts`
2. `packages/agent/src/tool-executor.ts`
3. `packages/agent/src/run-loop.ts`
4. `packages/agent/src/lifecycle.ts`
5. `packages/shared/src/dto.ts`

当前系统有两个关键特征：

1. **approval / pause / resume 是 durable 的**
   - `waiting_approval`
   - checkpoint
   - approve/reject 后 resume run
2. **工具执行仍然是串行的**
   - assistant 一轮里即使生成多个彼此独立的 tool call
   - `ToolExecutor.executePendingToolParts()` 也只会逐个执行

这使项目在“可恢复执行”上比 `../claude-code` 更强，但在“同轮独立工具低延迟执行”上更弱。

对于并行工具设计，存在两条可借鉴路线：

1. `../claude-code`
   - 原生接受一轮 assistant 中的多个 `tool_use`
   - runtime 内建 streaming tool executor
   - 通过 `isConcurrencySafe` 决定并发与独占
   - 但 approval 主要是进程内 permission queue，不是 durable checkpoint
2. `../opencode`
   - 模型显式调用一个 `batch` 工具
   - `batch` 内部统一执行多个 child tool
   - 对当前这种单 checkpoint 系统更友好

本项目不能直接照搬 Claude Code 的原生并行执行器，因为它的多 permission request 模型建立在：

1. 长活进程
2. 进程内 UI 队列
3. 当前 async 调用栈挂起等待用户操作

而本项目当前的核心能力恰恰是 durable pause/resume：

1. session status
2. run status
3. checkpoint
4. approval 持久化

如果直接把 Claude Code 式“同轮多个 top-level approval tool call”搬进来，会立刻把当前单 checkpoint 模型撕裂。

因此，本 RFC 采用混合路线：

1. **模型层学习 `../opencode` 的 `batch` 包装器**，让模型能够显式表达“这是一批相关的多工具调用”。
2. **执行层学习 `../claude-code` 的调度原则**，按工具并发安全性决定顺发与并发。
3. **durable truth 仍然保持本项目风格**，即落库的是多个真实 child `ToolPart` / `ToolCall`，而不是一个隐藏内部状态的 outer batch 结果块。

## 2. 目标

本 RFC 的目标如下：

1. 新增一个模型可见的 `batch` 工具，作为第一版并行能力的唯一入口。
2. `batch` 在进入 runtime 后立即展开成多个真实 child tool calls，不把 `batch` 自身作为主要 durable transcript 单元保留下来。
3. 为现有工具系统新增 `isConcurrencySafe` 元数据，默认 fail-closed。
4. 在执行层引入 Claude 风格的调度规则：
   - 并发安全 child 可以成组并行
   - 非并发安全 child 作为串行屏障独占执行
5. 对需要审批的 child 逐个走当前的 durable approval / checkpoint 模型，而不是审批一个总 batch。
6. crash / cancel 时不做 child-level resume；同 batch 中未完成或未执行 child 统一失败收口。
7. UI 默认只展示每个真实 child 工具，不展示 batch 包装器。

## 3. 非目标

本 RFC 首版明确不做：

1. 不实现 Claude Code 式 top-level 原生多 tool call 并行执行器。
2. 不实现多个 top-level approval checkpoint 同时挂起。
3. 不实现 child-level resume 或“从未完成 child 继续执行”。
4. 不实现 `batch` 嵌套 `batch`。
5. 不实现 `bash` 的条件性并发安全分类。
6. 不把 `plan_exit` 放进 batch。
7. 不要求前端立即实现复杂的 batch 可视化容器。

## 4. 核心判断

### 4.1 `batch` 是模型包装器，不是 durable 父节点

本 RFC 对 `batch` 的基本认知是：

1. 模型看到一个 `batch` 工具
2. assistant 调用 `batch(tool_calls=[...])`
3. `SessionProcessor` 在持久化边界把它展开为多个真实 child tool parts
4. 后续 runtime、approval、UI、下一轮上下文都只面向这些 child

也就是说：

1. `batch` 不应该在 UI 中作为一个单独工具卡片主展示
2. `batch` 不应该要求设计一套“outer payload child journal”来承载所有执行细节
3. `batch` 只保留最小批次关联元数据，用来支持调度、审批续跑和失败收口

### 4.2 durable truth 仍然是多个 child `ToolPart` / `ToolCall`

本 RFC 选择让 child 成为真实 durable 记录，原因如下：

1. 完成一个 child，就可以用当前现有机制落一个真实 tool result
2. 下一轮模型上下文能够自然看到每个 child 的 tool-call / tool-result
3. UI 可以复用现有单工具展示能力
4. approval 仍然可以逐个 child 进行，不需要新的 outer batch 审批模型
5. crash / cancel 时，未执行 child 也能按同一 durable 结构收口为 failed

### 4.3 仍然需要最小批次关联元数据

虽然 batch 在模型层和 UI 层可以“消失”，但在 durable runtime 内部不能完全无痕。

至少需要保留：

1. `batchId`
2. `batchIndex`
3. `batchGroupIndex`
4. `batchGroupKind`
5. `outerModelToolCallId`

否则无法解决：

1. child approval 后如何继续同一批剩余 child
2. crash / cancel 时如何准确找出同批未执行 child 并失败收口
3. 同一 assistant 响应里多个 child 的顺序与分组如何稳定重建

### 4.4 第一版不做 child-level resume

本 RFC 明确拒绝以下设计：

1. batch 中断后，下次恢复从第 N 个 child 继续执行
2. batch 批准后，重启进程再续跑剩余 child

首版策略是：

1. batch 执行一旦中断，相关 child 全部按当前 durable 状态收口
2. 已完成 child 保留 completed
3. running child 标记 failed/interrupted
4. 尚未执行 child 标记 failed/not executed
5. 然后停止，不再继续该 batch

### 4.5 第一版 `task_*` 允许进入 batch，但全部按独占执行

虽然之前参考 Claude Code 时曾考虑把 `task_*` 视为并发安全，但本项目当前 task service 直接操作共享的 session/task durable 状态，例如：

1. `currentTaskId`
2. `position`
3. `running/waiting_approval/blocked/done` 状态转换

因此第一版更稳妥的策略是：

1. `task_create`
2. `task_list`
3. `task_get`
4. `task_update`
5. `task_stop`

都允许出现在 batch 中，但一律按 non-concurrent / exclusive child 处理。

### 4.6 第一版 `bash` 固定不可并行

Claude Code 对 Bash 使用“只读命令才可并行”的条件策略。本 RFC 第一版不做该优化。

首版判断：

1. `bash` child 始终 `isConcurrencySafe = false`
2. 在 batch 内始终形成 exclusive group

### 4.7 `plan_exit` 第一版从 batch 排除

`plan_exit` 是 phase-boundary tool，不属于本 RFC 第一版 batch 支持范围。

原因：

1. 它会改变 mode / checkpoint / 会话阶段
2. 与“batch 只是多工具包装器”的目标不一致
3. 会显著增加 approval 续跑和失败收口的复杂度

因此：

1. `plan_exit` 继续作为普通 top-level tool 使用
2. `batch` 中若出现 `plan_exit`，直接报错

## 5. 第一版工具分类

### 5.1 新增工具元数据

在 `packages/agent/src/tools/core.ts` 的 `ToolDefinition` 上新增：

```ts
isConcurrencySafe?(input: z.infer<TInputSchema>): boolean
```

默认值：

1. 未声明则为 `false`

### 5.2 第一版并发安全工具

第一版只把真正明显独立的只读文件/搜索工具归为并发安全：

1. `read`
2. `glob`
3. `grep`

### 5.3 第一版独占工具

以下工具都允许作为 child 出现在 batch 中，但按 exclusive 执行：

1. `bash`
2. `write`
3. `edit`
4. `apply_patch`
5. `task_create`
6. `task_list`
7. `task_get`
8. `task_update`
9. `task_stop`

### 5.4 第一版禁止作为 batch child 的工具

1. `batch`
2. `plan_exit`

## 6. 模型层与运行时层的边界

### 6.1 模型层输入

模型显式调用：

```ts
batch({
  tool_calls: [
    { tool: 'read', parameters: { filePath: 'src/a.ts' } },
    { tool: 'grep', parameters: { pattern: 'foo', include: '*.ts' } },
    {
      tool: 'edit',
      parameters: { filePath: 'src/b.ts', oldString: 'x', newString: 'y' }
    }
  ]
});
```

### 6.2 SessionProcessor 扩展点

`SessionProcessor` 对 `toolName === 'batch'` 做 special-case：

1. 解析 outer `batch` payload
2. 校验 child 允许集
3. 禁止嵌套 batch
4. 为每个 child 生成真实 `ToolPart` / `ToolCallDto`
5. child 使用 synthetic `modelToolCallId`

建议 synthetic id 规则：

```text
<outerModelToolCallId>#<childIndex>
```

这样做的目的：

1. replay 给下一轮模型时，child 看起来就是普通 tool-call / tool-result
2. top-level batch wrapper 不进入 durable transcript 主体

### 6.3 child 的持久化时机

第一版建议在 batch 解析后 **一次性把所有 child parts/tool calls 都以 `pending` 持久化出来**。

原因：

1. approval 需要一个稳定的 child 记录可供 checkpoint 指向
2. crash / cancel 时，后续未执行 child 才有可更新的 durable 目标
3. UI 也可以即时知道这批计划里有哪些 child

这意味着：

1. batch wrapper 本身不作为主要 tool part 展示
2. durable transcript 中会直接出现多个 child tool parts

## 7. 数据模型

### 7.1 新增顶层 `batch` 工具名

需要扩展：

1. `packages/shared/src/dto.ts` 的 `ToolName`
2. `packages/agent/src/tools/index.ts` 的 registry
3. `packages/agent/src/context/tool-registry.ts` 的可见工具集合

新增 `ToolName = 'batch'`。

### 7.2 新增 child 批次关联元数据

本 RFC 建议为真实 child part / tool call 增加显式 batch 关联字段，而不是复用 `providerMetadata` 或 outer payload journal。

建议 shape：

```ts
type BatchChildRef = {
  batchId: string;
  batchIndex: number;
  batchGroupIndex: number;
  batchGroupKind: 'parallel' | 'exclusive';
  outerToolName: 'batch';
  outerModelToolCallId: string;
};
```

建议分别持久化到：

1. `MessagePart(type='tool')`
2. `ToolCallDto`

若首版不想引入独立 DB 列，可先放入显式的 JSON 字段，例如：

1. `MessagePart.batch`
2. `ToolCallDto.batch`

但不建议塞进 `providerMetadata`，因为它不是 provider 产生的数据。

### 7.3 不引入 outer batch child journal

本 RFC 明确不采用“outer batch payload child journal”方案。

原因：

1. 真实 child 已经是 durable truth
2. 现有上下文重建和 UI 都更容易复用
3. 不需要再造一套与 `ToolPart` 平行的内部日志结构

## 8. 审批模型

### 8.1 审批按 child 逐个进行

本 RFC 不再审批一个总 batch，而是：

1. 每个 child 仍沿用自己的 approval 语义
2. 需要审批的 child 仍然调用自己的 `buildApproval(...)`
3. 用户看到的是单个 child 工具的审批界面

这与当前 approval 系统最兼容。

### 8.2 只在 child 真正执行到时才构建审批 payload

对于 batch 中的多个需要审批的 child，不应在 batch 展开时一次性全部调用 `buildApproval(...)`。

应采用 **按需构建**：

1. 当前执行推进到某个 approval child 时
2. 再为该 child 调用 `buildApproval(...)`
3. 进入当前已有的 `waiting_approval` checkpoint

这样做的原因：

1. earlier child 可能改变后续 edit/write/apply_patch 的文件状态
2. 提前生成后续 child 的审批 payload 很容易过期
3. 当前 approval payload 校验逻辑本来就是单工具、按当前状态构建的

### 8.3 同一 batch 中允许多个审批 child，但一次只挂起一个

例如：

```text
read -> edit -> read -> apply_patch
```

执行语义应为：

1. `read` 自动执行
2. 到 `edit` 时进入 approval checkpoint
3. approve/reject 后继续 batch 剩余 child
4. 走到 `apply_patch` 时，再进入下一个 approval checkpoint

也就是说：

1. 同一 batch 可以包含多个 approval child
2. 但任何时刻只有一个 active `waiting_approval`

### 8.4 SessionProcessor 的“多审批 tool call”限制需要 special-case batch

当前 `SessionProcessor` 明确不支持同轮多个 approval-required top-level tool call。

本 RFC 需要在 batch 展开路径中绕过这条旧规则：

1. 非 batch 路径保持原限制不变
2. batch 路径允许展开出多个未来可能需要审批的 child
3. 但真正的 approval 由执行器按批次顺序一个个触发

## 9. 执行调度

### 9.1 批次执行计划

`ToolExecutor` 不再把 batch 当普通工具执行，而是 special-case 处理 batch child 集合。

执行计划结构建议为：

```ts
type BatchExecutionGroup = {
  index: number;
  kind: 'parallel' | 'exclusive';
  childPartIds: string[];
};
```

### 9.2 分组规则

从左到右扫描同一 `batchId` 的 child：

1. `isConcurrencySafe === true` -> 放入当前 parallel group
2. `isConcurrencySafe === false` -> 形成独占 group
3. group 与 group 按顺序执行

示例：

```text
read, grep, task_get, edit, write, read
```

变为：

```text
Group 1: parallel [read, grep]
Group 2: exclusive [task_get]
Group 3: exclusive [edit]
Group 4: exclusive [write]
Group 5: parallel [read]
```

注意：`task_get` 虽然是读语义，但在第一版仍按 exclusive 处理，以遵守“task\_\* 先不并行”的约束。

### 9.3 执行规则

1. parallel group
   - 组内 child 一起进入 running
   - `Promise.allSettled(...)` 等待自然收敛
2. exclusive group
   - 单 child 顺序执行
3. 遇到 approval child
   - 暂停当前批次推进
   - 进入当前已有的 single-child approval checkpoint

### 9.4 resume 后如何继续剩余 batch

这是本 RFC 与“batch 只是包装器”设计最关键的闭环。

当某个 approval child 被批准或拒绝后：

1. `executeApprovedPart(...)` 仍先处理当前这个 child
2. 然后 runtime 不能直接去重新向模型发下一轮请求
3. 必须先根据该 child 的 `batchId` 找到同批剩余 child
4. 继续把这一批执行到：
   - 全部完成
   - 或下一个 approval child
   - 或 batch 失败

因此需要新增一个类似：

```ts
ToolExecutor.continueBatch(batchId, fromPartId, ...)
```

或等价 API，由 `Lifecycle.resumeApprovalRun()` 在 approved/rejected 后先调用，再决定是否回到 `RunLoop.run()`。

## 10. 失败与恢复语义

### 10.1 fail-fast

本 RFC 首版采用 fail-fast：

1. 如果 exclusive child 失败
   - 当前批次失败
   - 后续所有尚未执行 child 直接写 failed
2. 如果 parallel group 中任一 child 失败
   - 该 group 内已启动 child 自然收敛
   - group 结束后批次失败
   - 后续所有尚未执行 child 直接写 failed

### 10.2 run cancel

当 run 被用户取消或 signal abort：

1. 已完成 child 保留 completed
2. running child 标记 failed/interrupted
3. pending 但未执行 child 标记 failed/not executed
4. 该批次停止，不再继续

### 10.3 process crash / startup recovery

当 server 在 batch 执行中崩溃：

1. 不尝试恢复并继续剩余 child 执行
2. recovery 逻辑只负责按 `batchId` 找到所有非终态 child
3. running child -> failed/interrupted
4. pending child -> failed/not executed
5. 然后结束，不再继续该批次

### 10.4 下一轮模型看到什么

由于 durable truth 是 child parts，所以下一轮模型看到的是：

1. 每个真实 child 的 tool-call
2. 每个真实 child 的 tool-result 或 error result

它不会看到一个抽象的 outer batch 结果块。

这符合“batch 只是模型包装器，进入 runtime 后只剩多个真实 tool”的目标。

## 11. UI 语义

第一版 UI 原则：

1. 不展示 batch 包装器
2. 只展示每个真实 child 工具
3. 可选地在调试信息或 detail pane 中展示 child 的 `batchId/groupIndex`

这允许前端复用当前现有 tool card / detail / approval UI，而不要求新增一套 batch 容器组件。

## 12. 实现计划

### Step 1: 新增 `batch` 模型工具

修改：

1. `packages/shared/src/dto.ts`
2. `packages/agent/src/tools/index.ts`
3. `packages/agent/src/context/tool-registry.ts`

新增：

1. `packages/agent/src/tools/batch/index.ts`
2. `packages/agent/src/tools/batch/prompt.ts`

### Step 2: 扩展 ToolDefinition

修改：

1. `packages/agent/src/tools/core.ts`
2. 所有现有工具 definition

首版显式填写：

1. `read/glob/grep -> true`
2. `bash/write/edit/apply_patch/task_*/plan_exit -> false`

### Step 3: SessionProcessor 增加 batch 展开路径

修改：

1. `packages/agent/src/session-processor.ts`

新增能力：

1. 识别 `toolName === 'batch'`
2. 校验 child allow set
3. 生成 synthetic child `modelToolCallId`
4. 一次性持久化所有 child 为真实 pending `ToolPart` / `ToolCall`
5. 绕过“同轮多个 approval top-level tool call 不支持”的旧限制

### Step 4: 持久化 batch 关联元数据

修改：

1. `packages/shared/src/dto.ts`
2. `packages/orm` schema
3. repository mapper / JSON 序列化

目标：

1. child 具备显式 `batchId/batchIndex/batchGroupIndex/batchGroupKind/outerModelToolCallId`

### Step 5: ToolExecutor 新增批次推进能力

修改：

1. `packages/agent/src/tool-executor.ts`

新增内部函数：

1. `buildBatchExecutionPlan(...)`
2. `executeBatchGroups(...)`
3. `continueBatch(...)`
4. `failPendingBatchChildren(...)`

### Step 6: Lifecycle 对 batch approval 续跑 special-case

修改：

1. `packages/agent/src/lifecycle.ts`

目标：

1. child approval resolve 后，先继续同一 batch 剩余 child
2. 只有 batch 本轮全部结束后，才回到下一轮模型调用

### Step 7: recovery 收口

修改：

1. server recovery / interrupted convergence 相关 service

目标：

1. crash 后按 `batchId` 收口所有未终态 child
2. 不继续执行剩余 child

### Step 8: 测试

至少新增以下测试：

1. `batch(read, grep)` 展开成两个真实 child tool parts，且二者并行执行
2. `batch(read, task_get, read)` 中 `task_get` 为 exclusive
3. `batch(... edit ...)` 进入单 child approval，并能在 approve 后继续同批剩余 child
4. 同一 batch 中两个 approval child 能按顺序各自审批
5. batch cancel / crash 后，未执行 child 被 durable 标记 failed/not executed
6. `batch(plan_exit)` 直接报错
7. UI/API 层读取 session message 时看不到 batch 包装器，只看到 child 工具

## 13. 风险与权衡

### 13.1 为什么不保留 outer batch durable 父节点

因为一旦把 outer batch 做成真正 durable 主节点，就会重新引入：

1. 子执行日志放哪里
2. UI 是展示 batch 还是展示 child
3. 下一轮模型看到 outer batch 还是 child

而这些都是你已经明确希望避免的。

### 13.2 为什么 child 全部先持久化为 pending

因为这是在“不做 child resume”的前提下，最容易把失败收口和逐个审批做对的方式。

如果只在执行到时才创建 child：

1. crash 时后续未执行 child 根本没有 durable 记录可收口
2. approval 后继续批次也缺稳定锚点

### 13.3 为什么 task 工具先全部独占

这不是说 task 工具永远不能并发，而是当前项目的 task service 直接操作共享 durable 状态，先保守分类最稳妥。

### 13.4 为什么不做 child-level resume

因为 child-level resume 会引入：

1. 批量副作用重放风险
2. 外层已批准、内层部分完成的复杂恢复语义
3. 更复杂的 startup recovery 决策树

相较之下，“批次中断即失败收口”更符合当前 durable 模型的简单性。

## 14. 验收标准

以下条件全部满足时，本 RFC 可视为完成：

1. 模型可以通过 top-level `batch` 包装器表达一组 child tool calls。
2. 进入 runtime 后，`batch` 被展开成多个真实 child `ToolPart` / `ToolCall`。
3. UI 默认展示 child 工具，而不展示 batch 包装器。
4. child 按 `isConcurrencySafe` 分组执行，而不是简单 `Promise.all`。
5. `task_*` 可进入 batch，但第一版全部独占执行。
6. `bash` 在第一版始终独占执行。
7. child approval 按单工具逐个进行，而不是审批一个总 batch。
8. batch cancel / crash 后，不继续剩余 child，未执行 child 被 durable 标记为失败。
9. 现有 run cancel、approval resume、session recovery、compaction 测试无回归。

## 15. 后续演进

本 RFC 完成后，可继续考虑：

1. 将 `bash` 升级为条件性并发安全工具。
2. 重新评估哪些 `task_*` 工具可提升为并发安全。
3. 若确有产品需求，再引入 batch 可视化分组或 batch 调试视图。
4. 更远期如有必要，再在此 child scheduler 之上扩展 top-level 原生多 tool call 执行器。
