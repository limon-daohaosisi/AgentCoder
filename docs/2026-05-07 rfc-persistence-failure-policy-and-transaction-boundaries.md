# RFC: Persistence Failure Policy、统一事务入口与 After-Commit Effect

日期：2026-05-07

状态：Draft

目标读者：人类维护者、coding agent

## 背景

当前项目已经有完整的 SQLite 持久化链路：

1. `sessions`
2. `agent_runs`
3. `messages`
4. `message_parts`
5. `tool_calls`
6. `approvals`
7. `session_events`

它们已经足以承载一次 agent run 的核心状态、恢复 checkpoint、timeline replay 和前端 session 详情。

当前项目也已经把最底层的 `ToolPart + tool_call` 收敛成局部事务。

对应实现位于：

1. `apps/server/src/repositories/tool-state-repository.ts`
2. `apps/server/src/services/agent/tool-state-service.ts`

但更高层的业务动作仍然是分散提交的。典型链路包括：

1. `apps/server/src/services/agent/interaction-service.ts`
2. `packages/agent/src/session-processor.ts`
3. `packages/agent/src/lifecycle.ts`
4. `packages/agent/src/tool-executor.ts`
5. `apps/server/src/services/agent/run-service.ts`
6. `apps/server/src/services/session/message/service.ts`
7. `apps/server/src/services/session-events/event-service.ts`

例如：

1. prompt setup 会分开执行 `createRun`、`createMessage`、`setTriggerMessage`、`append run.created`、`append message.created`、`update session.status`、`append session.updated`
2. approval pause 会分开执行 `createApproval`、`append tool.pending`、`append approval.created`、`markRunWaitingApproval`、`updateSessionRuntimeState(waiting_approval)`、`append session.resumable`、`append session.updated`
3. approval resolve 会分开执行 `markRunning`、`updateApprovalDecision`、`updateSessionRuntimeState(executing)`、`append approval.resolved`、再异步进入 tool 执行
4. run terminalize 会分开执行 `markRun*`、`updateSessionRuntimeState`、`append run.*`、`append session.updated`

这意味着系统里虽然有事务，但没有统一的持久化机制，也没有统一的 after-commit 副作用机制。

## 当前问题

### 1. 同一个业务动作的数据库写入被拆散

现在的主要问题不是 repository 文件分散，而是同一个业务动作跨越了太多层和太多次独立提交。

例如 approval pause 现在分散在：

1. `packages/agent/src/session-processor.ts`
2. `packages/agent/src/lifecycle.ts`
3. `apps/server/src/repositories/*.ts`

这会导致以下部分成功状态真实发生：

1. `approval` 已创建，但 `session.status` 仍不是 `waiting_approval`
2. `session.status` 已经 `waiting_approval`，但 `approval.created` / `session.resumable` 缺失
3. `approval` 已 `approved/rejected`，但 `ToolPart/tool_call` 仍保持 pending
4. `message` 已创建，但 `message_parts` 只写入了一部分
5. `run` 已 terminal，但 `run.*` 或 `session.updated` durable event 缺失

### 2. `sessionEventService.append()` 把 durable write 和 live publish 绑死了

当前 `apps/server/src/services/session-events/event-service.ts` 的 `append()` 同时做两件事：

1. 调 `sessionEventRepository.append(...)` 写 `session_events`
2. 立刻调 `sessionStreamHub.publish(...)` 发 live SSE

这使得事务边界很脏：

1. 事务还没结束，前端可能先看到了事件
2. 如果后续更大的业务动作失败，前端会收到一个并未真实提交的“幽灵事件”
3. 事务内很难统一组织“状态写入 + event row append + 提交后广播”

### 3. 当前项目缺少通用 after-commit 机制

`../opencode` 已经有一套更系统的基础设施：

1. `Database.transaction(...)`
2. `Database.effect(...)`
3. “事务内写 projection，事务提交后执行 publish”

对应代码位于：

1. `/home/daohaosisi/dev/opencode/packages/opencode/src/storage/db.ts`
2. `/home/daohaosisi/dev/opencode/packages/opencode/src/sync/index.ts`

其中：

1. `Database.transaction(...)` 统一建立事务上下文
2. `Database.effect(...)` 把副作用注册到当前事务上下文中
3. 最外层事务提交成功后，统一运行这些副作用

这个模式保证：

1. 数据库真源先落库
2. 广播和其他副作用后执行
3. publish 失败不会破坏已提交的 durable state
4. 事务回滚时不会出现已经广播出去但实际上未提交的状态

当前项目还没有这层统一机制。

## 目标

1. 引入本项目自己的统一事务入口。
2. 引入本项目自己的通用 after-commit effect 机制。
3. 把核心持久化动作统一改造成“事务内写 projection / durable state，事务后做 live publish”。
4. 让 `session_events` durable append 成为事务内写入，而不是附带行为。
5. 让 `sessionStreamHub.publish(...)` 仅作为 after-commit 副作用存在。
6. 让 repository 可以自动加入当前事务上下文，不再要求每层手工传 `tx`。
7. 保持 `packages/agent` 不依赖 server repository 或 DB 实现。
8. 不在模型流式生成或外部工具执行期间持有长事务。
9. 保持 startup recovery 继续作为 crash 后补偿机制。

## 非目标

1. 不把整个 run 包进一个长事务。
2. 不把所有 runtime bus 事件都持久化成 `session_events`。
3. 不在第一阶段引入队列、outbox、后台 worker。
4. 不改变现有对外 HTTP contract。
5. 不要求第一阶段把所有 event 类型都做成通用 event-sourcing 模式。
6. 不删除 startup recovery。

## 核心判断

### 1. 当前项目需要的不是更多局部事务，而是统一事务模型

只在 repository 层零散加事务是不够的。

因为当前问题不是单表写入没事务，而是：

1. 一个业务动作跨多个 repository
2. event append 和 live publish 混在一起
3. 上层 service/agent core 没有共享事务上下文

所以本 RFC 不再把设计中心放在“`RunPersistenceService` 手工收集 envelopes 再 publish”，而是改成和 `opencode` 同类的基础设施模型：

1. 统一事务入口
2. 统一事务上下文
3. 通用 after-commit effect

### 2. 本项目的 durable truth 仍然是 projection-first，而不是纯 event-sourcing

本项目当前的主要真源是这些业务表：

1. `sessions`
2. `agent_runs`
3. `messages`
4. `message_parts`
5. `tool_calls`
6. `approvals`

`session_events` 的职责是：

1. timeline durable replay
2. SSE replay
3. 调试与审计

它不是唯一真源，也不是 checkpoint 唯一来源。

所以本项目不应该完全复制 `opencode` 的 event-first projector 架构，而应该保留当前 projection-first 模型，但借用它的事务基础设施思想：

1. 事务内写核心 projection state
2. 事务内写 durable events
3. 事务提交后执行 publish

### 3. 当前项目第一阶段最合适的抽象是 `Database.transaction` + `Database.effect`

相比“每个 service 手工收集 `envelopes` 再调 `publishPersistedMany()`”，统一的基础设施更适合本项目，原因是：

1. approval pause / resolve / tool complete / run finalize 都需要 after-commit publish
2. 未来不只是事件发布，可能还会有别的 after-commit 行为
3. 统一机制可以减少服务层样板代码
4. 可以让 repository/service 在事务嵌套时复用同一个上下文

## 目标架构

### 一、统一事务入口：`Database.transaction(...)`

新增一个 server 侧数据库协调层，建议文件：

1. `apps/server/src/db/runtime.ts`

或者扩展现有：

1. `apps/server/src/db/client.ts`

建议提供：

1. `Database.use(callback)`
2. `Database.transaction(callback, options?)`
3. `Database.effect(callback)`

其中：

1. `Database.use()` 用于“拿当前 tx 或默认 db 执行读写”
2. `Database.transaction()` 用于建立最外层事务和事务上下文
3. `Database.effect()` 用于注册 after-commit 副作用

推荐行为与 `opencode` 保持一致：

1. 如果当前已经在事务上下文里，`Database.transaction()` 直接复用当前 tx 执行 callback，不再开启新的顶层事务
2. 只有最外层事务负责真正 commit 和执行 after-commit effects
3. 如果事务回滚，则丢弃当前事务收集到的 effects
4. `Database.transaction()` 的 callback 必须是同步的，不允许跨 `await`

### 二、统一 after-commit 副作用：`Database.effect(...)`

`Database.effect(...)` 的职责是：

1. 在事务上下文中注册一个副作用
2. 副作用只有在最外层事务成功提交后才执行
3. 若当前不在事务上下文，则立即执行

这意味着：

1. `sessionStreamHub.publish(...)` 不再直接在事务中调用
2. 所有 live publish 都通过 `Database.effect(...)` 推迟到 commit 之后

### 三、projection-first 的事务内写入

本项目不做通用 `SyncEvent.project(...)`，但要求所有关键业务动作遵循同一模式：

1. 事务内更新业务表 projection
2. 事务内追加 `session_events` durable row
3. 通过 `Database.effect(...)` 注册 `sessionStreamHub.publish(...)`

用简单的话说：

1. 先把账本写好
2. 确认提交成功
3. 再对外广播

### 四、如何整合分散在不同文件中的写库

当前项目的一个现实情况是：同一个业务动作涉及的写库并不集中在一个文件里，而是分散在多个 service、repository 甚至 `packages/agent` 的不同类中。

这本身不是问题。

真正的问题要区分成两类。

#### 1. 同一执行阶段内的分散写库

如果多个写库动作虽然分散在不同文件，但它们仍然发生在同一次调用链、同一个执行阶段中，那么可以直接靠统一事务上下文整合。

例如：

```ts
Database.transaction(() => {
  agentRunService.createRun(...)
  messageService.createMessage(...)
  sessionService.updateSessionRuntimeState(...)
  sessionEventService.append(...)
})
```

此时虽然：

1. `agentRunService` 在一个文件
2. `messageService` 在一个文件
3. `sessionService` 在一个文件
4. `sessionEventService` 在一个文件

但它们内部最终都通过 `Database.use((db) => ...)` 拿到当前事务中的 `tx`，因此仍然属于同一个事务。

换句话说：

1. 文件分散不是问题
2. 只要调用链还在同一个 `Database.transaction(...)` callback 内，就能共享同一个事务上下文

#### 2. 已经拆成多个执行阶段的分散写库

如果同一个业务动作已经被拆成前后两个执行阶段，那么不能只靠事务上下文自动合并。

这是因为事务上下文只能覆盖同一个 callback 内的连续执行，不能跨越“前一阶段先返回结果，后一阶段再继续处理”的边界。

当前项目最典型的例子就是 approval pause：

1. `SessionProcessor` 先识别出需要 pause
2. `RunLoop` / `Lifecycle` 再决定如何收敛 run/session

如果第一阶段已经先写了一半库，而第二阶段再补另一半，那么再好的事务上下文也只能覆盖各自那一小段，无法把两段已经分离的持久化重新拼成一个原子动作。

因此，对这种跨阶段动作，标准模式不是“让第一阶段先写一半库”，而是：

1. 第一阶段只返回结构化意图或结构化结果
2. 这个结果只作为当前调用链里的短暂内存对象存在
3. server 侧拿到这个结果后，立即开启一个事务，把完整状态一次性持久化
4. commit 成功后再 publish

这不是把系统真相放到内存里。

这里的内存对象只是一个临时的函数返回值，用来承载“下一步应该如何持久化”的语义；真正的 durable truth 仍然只在数据库中。

这和当前的坏状态不同。

当前坏状态是：

1. 数据库已经先写入一半状态
2. 另一半状态还没写
3. 结果系统产生半真相

目标模式则是：

1. 事务开始前，只有一个短暂的内存意图对象
2. 事务提交后，数据库里才出现完整真相
3. 事务失败时，不留下半写入状态

## 需要新增的基础设施

### 1. `Database.use()`

目标：让 repository 不必显式接受 `tx` 参数，也能自动加入当前事务。

推荐用法：

```ts
Database.use((db) => {
  return db.insert(...).values(...).returning().get()
})
```

如果当前存在事务上下文，则 `db` 就是 `tx`。

如果不存在事务上下文，则 `db` 就是全局 `db`。

### 2. `Database.transaction()`

推荐语义：

1. 最外层开启真正 SQLite 事务
2. 建立上下文：`{ tx, effects }`
3. callback 成功后 commit
4. commit 成功后顺序执行 `effects`
5. callback 抛错则 rollback 且不执行 effects

额外约束：

1. callback 只允许同步数据库读写与本地同步计算
2. callback 内不允许 `await`
3. callback 内不允许模型调用、网络 I/O、外部 tool 执行、SSE publish
4. 所有长生命周期操作必须发生在事务提交之后

原因：当前项目底层使用 `better-sqlite3 + drizzle-orm/better-sqlite3`，事务模型应保持短、小、同步。

### 3. `Database.effect()`

推荐语义：

1. 如果在事务上下文中，则把副作用放进 `effects[]`
2. 如果不在事务中，则立即执行

### 4. `sessionEventService.append()` 重构

文件：`apps/server/src/services/session-events/event-service.ts`

目标：

1. `append()` 只负责 durable append + 注册 after-commit publish
2. 不再同步直接 publish

推荐行为：

1. `sessionEventRepository.append(...)` 在当前事务内写 row
2. 返回 envelope
3. 调 `Database.effect(() => sessionStreamHub.publish(envelope))`

这样 service 调 `append()` 时，无需关心当前是否在事务中：

1. 在事务中：publish 延后
2. 不在事务中：publish 立即执行

## repository 改造原则

### 1. repository 不再直接依赖全局 `db`

当前 repository 普遍是：

1. `import { db } from '../db/client.js'`
2. 直接执行 `db.insert/update/select/...`

目标改成：

1. `import { Database } from '../db/runtime.js'`
2. 用 `Database.use((db) => ...)`

这样 repository 本身就自动支持：

1. 事务内执行
2. 非事务执行
3. 嵌套事务调用

### 2. 现有“自己开事务”的 repository 要适配统一机制

当前这些文件内部直接 `db.transaction(...)`：

1. `apps/server/src/repositories/tool-state-repository.ts`
2. `apps/server/src/repositories/session-event-repository.ts`
3. `apps/server/src/repositories/session-recovery-repository.ts`

目标：

1. 普通 live path repository 方法改成 `Database.transaction(...)`
2. 在已有事务中自动复用当前上下文
3. recovery repository 可继续显式开启顶层事务，但也应复用同一基础设施

对于 `sessionEventRepository.append()`，还必须额外满足一个不变量：

1. `sequenceNo` 分配与 event row 插入必须属于同一个原子单元
2. 如果当前存在 ambient transaction，则复用外层事务完成“读取当前最大 sequenceNo + 插入新 row”
3. 如果当前不存在 ambient transaction，则 `append()` 必须自行开启一个本地事务

也就是说，`sessionEventRepository.append()` 不能只是机械地改成 `Database.use((db) => ...)` 后裸跑两条语句；必须始终保证 sequence 分配和插入是事务内原子完成的。

## 业务动作的目标事务边界

以下各动作不采用“手工收集 envelopes 再 publish”的模式，而统一采用：

1. `Database.transaction(...)`
2. 事务内执行状态写入
3. 事务内调用 `sessionEventService.append(...)`
4. `sessionEventService.append(...)` 内部注册 after-commit publish

### A. prompt setup

当前文件：`apps/server/src/services/agent/interaction-service.ts`

在进入持久化 `setup()` 之前，还必须先解决同 session 并发请求的保留位问题。

当前 `SessionRunner.ensureRunning()` 的并发窗口在于：它是在 `await setup()` 返回后才把 session 写入 `activeRuns`。因此两个并发请求可能同时通过检查，并各自提交一份 open run 状态。

第一阶段采用最小改动方案：

1. 为 `SessionRunner` 增加 setup 前的内存保留位
2. 在进入 `setup()` 之前先占住当前 session
3. `setup()` 失败时释放保留位
4. `setup()` 成功后，把保留位升级为真正的 active run

`SessionRunner` 仍然只负责内存互斥与 abort control，不直接写 DB。

目标单事务包含：

1. `agentRunService.createRun(...)`
2. `messageService.createMessage(...)`
3. `agentRunService.setTriggerMessage(...)`
4. `sessionService.updateSessionRuntimeState(status = 'executing')`
5. `sessionEventService.append(run.created)`
6. `sessionEventService.append(message.created)`
7. `sessionEventService.append(session.updated)`

事务提交成功后：

1. 这些 event 自动 after-commit publish
2. 再把 `SessionRunner.ensureRunning(...)` 的 run 部分启动起来

### B. assistant message create

当前文件：`packages/agent/src/session-processor.ts`

`ensureAssistantMessage()` 需要保证：

1. 创建 assistant `message`
2. 如有需要写入初始 `message_parts`
3. 追加 `message.created`

这些在一个短事务中完成。

### C. assistant message complete / cancel / fail

当前文件：`packages/agent/src/session-processor.ts`

目标：

1. `updateMessageRuntime(...)`
2. `sessionEventService.append(message.completed/message.cancelled)`

同事务。

`message.failed` 当前 contract 中没有 event，可先保持只通过 run failure 表达。

### D. approval pause

当前文件：

1. `packages/agent/src/session-processor.ts`
2. `packages/agent/src/lifecycle.ts`

这是当前项目最典型的“跨执行阶段分散写库”场景，因此不能只靠共享事务上下文解决。

目标模式应明确为：

1. `SessionProcessor` 不再直接 `createApproval()` 或 `appendSessionEvent()` 写 approval pause 的半套状态
2. `SessionProcessor` 只返回一个结构化 pause 意图
3. 这个 pause 意图只作为当前调用链中的临时内存对象存在
4. `Lifecycle` 或 server 侧编排层拿到这个意图后，开启一个事务，一次性写完完整状态

推荐返回形态可以类似：

```ts
{
  kind: 'pause_for_approval',
  approvalPayload: ...,
  checkpoint: ...,
  toolCall: ...,
  part: ...
}
```

这里的关键不是字段名，而是职责边界：

1. `packages/agent` 负责判断“现在应该进入 approval pause”以及构造进入该状态所需的数据
2. `apps/server` 负责把这个状态持久化成数据库真相

目标：把当前分散动作收敛到一个事务中：

1. 创建 `approval`
2. 更新 `agent_run.status = waiting_approval`
3. 更新 `agent_run.lastCheckpointJson`
4. 更新 `session.status = waiting_approval`
5. 更新 `session.lastCheckpointJson`
6. 清理 `session.lastErrorText`
7. 追加 `tool.pending`
8. 追加 `approval.created`
9. 追加 `session.resumable`
10. 追加 `session.updated`

事务提交成功后：

1. 这些 event 通过 after-commit 自动 publish

不允许的实现方式：

1. `SessionProcessor` 先把 `approval` 和部分 event 写入数据库
2. `Lifecycle` 再补写 `run/session/checkpoint` 和其他 event

因为这种做法虽然看起来仍然是同一个业务动作，但实际上已经被拆成两次独立持久化，无法保证原子性。

### E. approval resolve rejected

当前文件：

1. `apps/server/src/services/agent/interaction-service.ts`
2. `packages/agent/src/tool-executor.ts`

由于 reject 没有外部副作用，应收敛成一个事务：

1. `approval.status = rejected`
2. `ToolPart.state = error(execution_denied)`
3. `tool_call.status = failed/rejected`
4. `agent_run.status = running`
5. 清空 `agent_run.lastCheckpointJson`
6. `session.status = executing`
7. 清空 `session.lastCheckpointJson`
8. `sessionEventService.append(approval.resolved)`
9. `sessionEventService.append(tool.failed)`
10. `sessionEventService.append(session.updated)`

这条路径不改变当前 approval resume 的核心前置条件：在真正开始执行工具之前，approval 相关 `ToolPart/tool_call` 仍然保持 waiting approval 阶段的 pending 语义；reject 事务直接把它们收敛到失败终态即可。

### F. approval resolve approved

当前文件：

1. `apps/server/src/services/agent/interaction-service.ts`
2. `packages/agent/src/tool-executor.ts`

当前项目第一阶段采用保守路线，不修改现有 approval resume 的核心状态机语义。

也就是说，批准路径保留当前语义：

1. waiting approval 阶段的 `ToolPart/tool_call` 在真正开始执行前仍保持 pending
2. `approval-resume.ts` 的恢复校验仍以 pending 为前提
3. `ToolExecutor.executeApprovedPart()` 仍从 pending part 开始推进到 running

因此 approval approve 的第一段事务只应完成：

1. `approval.status = approved`
2. `agent_run.status = running`
3. 清空 `agent_run.lastCheckpointJson`
4. `session.status = executing`
5. 清空 `session.lastCheckpointJson`
6. `sessionEventService.append(approval.resolved)`
7. `sessionEventService.append(session.updated)`

事务提交成功后，才真正进入 `executeApprovedPart()`。

随后由现有工具执行语义推进：

1. pending -> running
2. 追加 `tool.running`
3. 再执行外部 tool
4. 最终 completed 或 failed

这条保守路线的目的，是避免在第一阶段同步重写 `packages/agent/src/approval-resume.ts`、`packages/agent/src/tool-executor.ts` 和 `Lifecycle.resumeApprovalRun()` 的恢复前置条件。

对应地，`tool.running` 在第一阶段不做语义迁移，仍保持“工具调用已经真正开始执行”的现有含义。当前前端和消费者无需因为本 RFC 对 `tool.running`` 的展示文案作语义调整。

### G. tool complete / fail

当前文件：`packages/agent/src/tool-executor.ts`

目标：

1. `updateToolPartWithToolCall(...)`
2. `sessionEventService.append(tool.completed/tool.failed)`

同事务。

不再允许“tool 已 completed，但 event durable row 缺失”。

### H. run finalize

当前文件：`packages/agent/src/lifecycle.ts`

目标：把下面这些动作统一放进一个事务：

1. `markRunCompleted / markRunFailed / markRunCancelled / markRunBlocked`
2. `updateSessionRuntimeState(...)`
3. `sessionEventService.append(run.*)`
4. `sessionEventService.append(session.updated)`

### I. cancel current run

当前文件：`apps/server/src/services/agent/run-service.ts`

目标：向 startup recovery 的事务化风格靠拢：

1. `markCancelled`
2. reject pending approvals
3. cancel running messages
4. fail open tool parts
5. fail open tool calls
6. update session idle
7. append all durable events
8. after-commit publish

## 对 `packages/agent` 的落地要求

### 1. 不把事务逻辑放进 `packages/agent`

`packages/agent` 仍然不能依赖 server DB 实现。

事务入口和 effect 机制只存在于 `apps/server`。

### 2. 但要减少细粒度 persistence deps

当前 `SessionProcessorDeps`、`LifecycleDeps`、`ToolExecutorDeps` 太细，导致一个业务动作被拆成多个 server 写入。

目标方向：

1. `SessionProcessor` 更偏向产出结构化结果
2. `Lifecycle` 在 server 侧调用更高层 persistence action
3. `ToolExecutor` 用更高层 deps 表达“mark running / mark completed / mark failed”

不强求第一阶段一步到位，但方向必须明确。

## 基础设施与文件级改造建议

### 1. 新增 `apps/server/src/db/runtime.ts`

建议职责：

1. 封装 `Database.use()`
2. 封装 `Database.transaction()`
3. 封装 `Database.effect()`
4. 内部维护事务上下文与 after-commit effect 队列

### 2. 修改 `apps/server/src/repositories/*.ts`

目标：

1. 不再直接使用全局 `db`
2. 改为 `Database.use((db) => ...)`

优先文件：

1. `message-repository.ts`
2. `message-part-repository.ts`
3. `session-repository.ts`
4. `agent-run-repository.ts`
5. `approval-repository.ts`
6. `tool-call-repository.ts`
7. `tool-state-repository.ts`
8. `session-event-repository.ts`

### 3. 修改 `apps/server/src/services/session-events/event-service.ts`

目标：

1. durable append 在当前事务上下文内执行
2. `sessionStreamHub.publish(...)` 改为 `Database.effect(...)`
3. `publishPersisted/publishPersistedMany` 保留给 recovery 或特殊路径复用

### 4. 修改 `apps/server/src/services/session/message/service.ts`

目标：

1. `createMessage()` 内部改为 `Database.transaction(...)`
2. `message + parts` 原子化

### 5. 修改 `apps/server/src/services/agent/interaction-service.ts`

目标：

1. prompt setup 放进一个事务
2. approval resolve 的状态迁移放进一个事务
3. 不在事务未提交前启动 run 或执行 tool
4. 配合 `SessionRunner` 的 setup 前内存保留位，避免并发请求在 setup 阶段各自写出一份 open state

### 6. 修改 `packages/agent/src/lifecycle.ts`

目标：

1. terminalize 路径不再零碎写入
2. 改由 server 注入的高层持久化动作处理

### 7. 修改 `packages/agent/src/tool-executor.ts`

目标：

1. running/completed/failed 不再自己分开 `update + appendEvent`
2. 改用高层原子化 deps

## 失败策略

### 1. 事务内任何 durable write 失败

包括：

1. 核心状态写入失败
2. `session_events` row append 失败

统一策略：

1. 事务回滚
2. 不执行已注册的 after-commit effects
3. 当前业务动作失败
4. 调用方决定把 run 收敛为 failed 或 blocked

### 2. after-commit effect 失败

包括：

1. `sessionStreamHub.publish(...)` 失败

统一策略：

1. 不回滚已提交事务
2. 记录 warning
3. 前端通过 SSE reconnect + replay 补齐

### 3. 外部副作用执行失败

例如 tool 真正执行时报错：

1. 不能回滚已经发生的外部副作用
2. 但必须开启新的短事务，把本地状态收敛到 failed
3. 并追加 durable `tool.failed`

## 分阶段实施计划

### Phase 0：基础设施

1. 新增 `Database.use/transaction/effect`
2. repository 全量接入 `Database.use`
3. `sessionEventService.append()` 改为 durable append + after-commit publish
4. 明确 `sessionEventRepository.append()` 的 sequence 分配原子性实现

验收：

1. 在事务上下文中 append event 时，不会立即 publish
2. 回滚时不会有 live event 泄漏出去

### Phase 1：message 原子化

1. `messageService.createMessage()` 事务化
2. assistant message created/completed/cancelled 路径事务化

### Phase 2：prompt setup 与 run terminalize

1. `interaction-service.prompt()` setup 事务化
2. `Lifecycle.handleResult()` 和 `handleFailure()` 改为原子持久化动作
3. `SessionRunner` 增加 setup 前内存保留位

### Phase 3：approval pause / resolve

1. approval pause 原子化
2. approval reject 原子化
3. approval approve 采用保守路线：先原子持久化 `approval approved + run/session 恢复执行态`，再沿用当前 pending -> executeApprovedPart -> running 语义

### Phase 4：tool completion / failure

1. `ToolExecutor` 的 running/completed/failed 切换原子化

### Phase 5：cancel path 与 recovery 对齐

1. `cancelCurrentRun()` 收敛到统一事务模型
2. 让 live path 与 startup recovery 共享同一持久化原则

## 测试计划

### 1. 基础设施测试

1. `Database.transaction()` 成功时执行 after-commit effects
2. `Database.transaction()` 回滚时不执行 effects
3. 嵌套 `Database.transaction()` 只在最外层提交后执行 effects
4. transaction callback 内禁止 `await` 与长操作

### 2. event service 测试

1. 事务内 `sessionEventService.append()` 不应立刻 publish
2. commit 后应 publish
3. rollback 后不应 publish
4. `sessionEventRepository.append()` 在 standalone 场景下仍保证 `sequenceNo` 分配与插入原子完成

### 3. 业务动作测试

1. prompt setup 任一子步骤失败，不留下半成品 run/message/session/event
2. approval pause 任一子步骤失败，不留下半成品 approval/waiting_approval 状态
3. `SessionRunner` 并发 prompt/resolve setup 不会各自提交一份 open run 状态
4. approval approve 保持当前恢复前提：pending part/tool_call 仍可被 `resumeApprovalRun()` 正常恢复
5. approval reject 事务化后不留下半成品 approval/tool/session 状态
6. tool complete/fail 不再出现状态已变更但 durable event 缺失
7. run finalize 不再出现 run/session 已变更但 `run.*` / `session.updated` 缺失

### 4. publish failure 测试

1. 人为让 `sessionStreamHub.publish()` 失败
2. 验证事务仍提交成功
3. 验证 replay 仍能读到 durable event

## 验收标准

完成本 RFC 第一阶段后，应满足：

1. 当前项目拥有统一事务入口 `Database.transaction(...)`
2. 当前项目拥有通用 after-commit 副作用入口 `Database.effect(...)`
3. repository 自动加入当前事务上下文
4. `sessionEventService.append()` 不再同步直接 publish
5. 所有关键 durable event 都是“事务内落库，事务后广播”
6. 不再出现回滚后前端已收到幽灵事件
7. `SessionRunner` 在 setup 前就建立内存保留位，避免并发 setup 双写 open state
8. approval approve 第一阶段保持当前 pending -> running 的恢复语义，不引入新的 `tool.running` 含义漂移
9. `sessionEventRepository.append()` 在有无 ambient transaction 的两种场景下都保证 sequence 分配原子性
10. startup recovery 继续有效，但不再承担 live path 事务内半提交修复职责

## 总结

本 RFC 的重构方向，不再是“在现有 service 上继续手工缝合事务与 publish 逻辑”，而是引入一层与 `opencode` 同类的基础设施：

1. `Database.transaction(...)`
2. `Database.effect(...)`
3. projection-first 的事务内 durable write
4. after-commit 的 live publish

本项目不会完全照搬 `opencode` 的 event-first projector 架构，因为当前真源仍是 `sessions/agent_runs/messages/message_parts/tool_calls/approvals` 这些 projection tables。

但本项目应当直接采用它的事务模型：

1. 在事务里写真源和 durable event
2. 在提交后发 live event
3. 把回滚与广播严格分开

这是当前项目从“局部事务化”走向“统一 persistence failure policy”的正确收敛路径。
