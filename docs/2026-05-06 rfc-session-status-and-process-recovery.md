# RFC: Session 状态收敛与 Process Recovery

日期：2026-05-06

状态：Draft

目标读者：人类维护者、coding agent

## 背景

当前系统已经有 `sessions`、`agent_runs`、`messages`、`message_parts`、`tool_calls`、`approvals` 和 `session_events`，可以记录一次 agent 执行的核心状态。

但当前状态模型还有三个问题。

第一，`session.status` 里存在 `failed`。这会把“一次 run 失败”和“整个 session 不可继续”混在一起。实际产品语义里，模型请求失败、provider timeout、stream 报错、普通 runtime 异常，通常只代表这一次 `agent_run` 失败，不代表 session 容器报废。

第二，`blocked` 在 run 层和 session 层的语义还没有拆清楚。`agent_run.blocked` 应表达“这一次 run 因某个原因不能继续”；`session.blocked` 应表达“这个 session 需要先执行一个恢复动作，否则不能接收新的用户输入”。这两者不应无条件绑定。

第三，当前没有 server startup process recovery。`SessionRunner` 的 active run 锁是内存态，进程重启后会丢失。数据库里可能仍然残留 `session.status = executing`、`agent_runs.status = running`、`messages.status = running`、`tool_parts.state.status = running` 或 open `tool_calls`，但 server 启动时不会主动扫描和收敛这些状态。

## 目标

1. 从 session 状态模型中移除 `failed`。
2. 把失败归属收敛到 `agent_runs.status = failed` 和 `session.lastErrorText`。
3. 明确区分 `agent_run.blocked` 与 `session.blocked`。
4. 普通 run 失败后，session 应回到 `idle`，允许用户继续输入。
5. 只有 session 级阻塞问题才进入 `session.status = blocked`。
6. 增加 server startup process recovery，启动时扫描并修复重启前遗留的 executing/running 状态。
7. 第一阶段 recovery 采用保守策略，不自动重复执行模型或副作用工具。
8. 完全移除 `session.failed` 事件语义，不再用事件名表达 session 失败。

## 非目标

1. 不在本 RFC 中实现自动 compact。
2. 不在第一阶段自动恢复执行中的模型 run。
3. 不在第一阶段自动重放 `write_file` 或 `run_command`。
4. 不引入队列/worker 架构。
5. 不改变 approval approve/reject 的 HTTP contract。
6. 不删除 `agent_runs.status = failed`。
7. 不保证保留当前本地 SQLite 开发库中的历史数据；当前阶段允许删除本地数据库后按新 schema 重建。

## 核心判断

`Session` 是长期会话容器，`AgentRun` 是一次执行实例。

因此失败语义应优先落在 run 上：

```text
agent_run.status = failed
session.status = idle
session.lastErrorText = <last run error>
```

只有当 session 本身无法安全继续时，才使用：

```text
session.status = blocked
```

`session.status = failed` 不再需要。它和 `session.status = blocked` 语义重叠，而且会让普通错误把 session 永久锁死。

同理，`session.failed` 事件也不再需要。普通 run failure 用 `run.failed + session.updated` 表达；session 级阻塞用 `run.blocked + session.blocked + session.updated` 表达；startup recovery 用 `session.recovered + session.updated` 表达。

## 目标状态模型

### SessionStatus

目标 `SessionStatus`：

```ts
type SessionStatus =
  | 'planning'
  | 'idle'
  | 'executing'
  | 'waiting_approval'
  | 'blocked'
  | 'completed'
  | 'archived';
```

状态含义：

| 状态               | 含义                                             |
| ------------------ | ------------------------------------------------ |
| `planning`         | session 刚创建，还没有正式执行                   |
| `idle`             | 当前没有 active run，可以接收新的用户输入        |
| `executing`        | 当前进程内应存在一个 active run 正在执行         |
| `waiting_approval` | 当前 run 暂停，等待用户 approve/reject           |
| `blocked`          | session 需要先执行恢复动作，否则不能继续         |
| `completed`        | session 整体任务完成，当前主链路可以暂不主动使用 |
| `archived`         | session 已归档，不可继续操作                     |

需要移除：

```text
failed
```

### AgentRunStatus

`AgentRunStatus` 保留：

```ts
type AgentRunStatus =
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'blocked';
```

状态含义：

| 状态               | 含义                         |
| ------------------ | ---------------------------- |
| `running`          | run 正在执行                 |
| `waiting_approval` | run 暂停等待 approval        |
| `completed`        | run 正常结束                 |
| `cancelled`        | run 被用户取消或系统明确中断 |
| `failed`           | run 因普通错误失败           |
| `blocked`          | run 因可识别阻塞原因无法继续 |

## run blocked 与 session blocked 的区别

`agent_run.blocked` 表示这一次 run 被阻塞。它不必然意味着整个 session 不能继续。

`session.blocked` 表示这个 session 当前不能接收新的用户输入，必须先执行某个恢复动作。

推荐规则：

| 场景                                | run 状态             | session 状态        | 原因                                        |
| ----------------------------------- | -------------------- | ------------------- | ------------------------------------------- |
| provider timeout                    | `failed`             | `idle`              | 用户可以重试或继续输入                      |
| 模型 stream 报错                    | `failed`             | `idle`              | 失败属于本次 run                            |
| 用户取消 run                        | `cancelled`          | `idle`              | 用户明确中断，session 可继续                |
| server 重启中断 run，状态可安全收敛 | `blocked`            | `idle`              | 不自动重跑，但允许用户决定下一步            |
| context too large 且 compact 未实现 | `blocked`            | `blocked`           | 下一次输入仍会失败，需要 compact/reset/fork |
| waiting approval checkpoint 不一致  | `blocked`            | `blocked`           | 需要恢复动作，不能假装可继续                |
| 数据库状态互相矛盾                  | `blocked`            | `blocked`           | 需要人工或专门 recovery 修复                |
| 同一 session 存在多个 open run      | 全部收敛为 `blocked` | `idle` 或 `blocked` | recovery 必须记录诊断，不允许只处理最新 run |

第一阶段建议：

```text
普通 failure -> run.failed + session.idle
用户取消 -> run.cancelled + session.idle
startup interrupted -> run.blocked + session.idle
需要恢复动作 -> run.blocked + session.blocked
```

如果 startup recovery 发现同一个 session 下有多个 open run，第一阶段必须全部收敛，不能只处理最新 run。若所有 open run 都可安全标记为 interrupted，则 session 回到 `idle`，并把诊断写入 `lastErrorText` 和 recovery event；若其中存在无法判定的 waiting approval 或 checkpoint 冲突，则 session 进入 `blocked`，并保留 `lastCheckpointJson` 作为诊断依据。

## 状态流转

目标主流转：

```text
planning -> executing
idle -> executing
executing -> idle
executing -> waiting_approval
waiting_approval -> executing
waiting_approval -> idle
executing -> blocked
idle -> archived
```

不再使用：

```text
executing -> failed
```

普通失败改为：

```text
executing -> idle
```

并同时记录：

```text
agent_run.status = failed
session.lastErrorText = <error>
session_event = run.failed
session_event = session.updated
```

不再追加：

```text
session_event = session.failed
```

## 需要修改的源码位置

### Shared

文件：`packages/shared/src/contracts.ts`

把：

```ts
export const sessionStatusSchema = z.enum([
  'planning',
  'idle',
  'executing',
  'waiting_approval',
  'blocked',
  'failed',
  'completed',
  'archived'
]);
```

改为：

```ts
export const sessionStatusSchema = z.enum([
  'planning',
  'idle',
  'executing',
  'waiting_approval',
  'blocked',
  'completed',
  'archived'
]);
```

### DB schema

文件：`packages/db/schema/sessions.lt.hcl`

把 check 从：

```text
status IN ('planning', 'idle', 'executing', 'waiting_approval', 'blocked', 'failed', 'completed', 'archived')
```

改为：

```text
status IN ('planning', 'idle', 'executing', 'waiting_approval', 'blocked', 'completed', 'archived')
```

迁移时需要把历史 `failed` session 转为：

```text
status = 'idle'
last_error_text 保留原值
```

如果历史 `failed` session 没有 `last_error_text`，迁移可以填入：

```text
Session was migrated from failed to idle.
```

当前开发阶段允许删除本地 SQLite 数据库后按新 schema 重建，因此不要求为了本地库保留历史数据。但如果生成正式 migration 或需要保留共享环境数据，必须仍按上面的规则迁移历史 `failed`。

### ORM

文件：`packages/orm/src/schema.ts`

通过 `pnpm db:sync` 从数据库同步，不要手写长期漂移的 check。

### Agent lifecycle

文件：`packages/agent/src/lifecycle.ts`

当前 `handleFailure()` 不应再把 session 设为 `failed`。

目标策略：

```text
handleFailure()
  -> markRunFailed(...)
  -> updateSessionRuntimeState(status = 'idle', lastErrorText = error)
  -> append run.failed
  -> append session.updated
```

`context_too_large` 仍应保持：

```text
run.status = blocked
session.status = blocked
session.lastErrorText = context_too_large_compact_not_implemented
```

原因：没有 compact/reset/fork 前，恢复为 `idle` 只会导致下一次继续失败。

### Session interaction

文件：`apps/server/src/services/agent/interaction-service.ts`

提交新 prompt 仍只允许：

```text
planning
idle
```

不新增从 `blocked` 直接 prompt 的能力。`blocked` 必须先通过明确 recovery/compact/reset/fork 动作解除。

### Frontend

前端需要移除 `session.status === 'failed'` 的展示分支。

已知影响位置包括：

```text
apps/web/src/features/sessions/session-list.tsx
apps/web/src/lib/session-view.ts
```

`apps/web/src/features/tasks/task-board.tsx` 中的 `failed` 当前属于 mock task status，不是 `SessionStatus.failed`，不要误删非 session 状态。

普通错误展示应依赖：

```text
session.status = idle
session.lastErrorText != null
```

推荐 UI 文案：

```text
上一次运行失败：<lastErrorText>
你可以继续输入或重试。
```

`blocked` 文案应更强：

```text
当前会话被阻塞，需要先恢复后才能继续。
```

### Shared checkpoint

文件：`packages/shared/src/dto.ts`

`SessionCheckpoint.kind` 当前包含：

```text
failed
```

本 RFC 不要求在 Phase 1 移除 `SessionCheckpoint.kind = 'failed'`。它不是 `SessionStatus.failed`，也不是 `session.failed` 事件。后续如果确认 checkpoint failed 没有使用场景，可以单独 RFC 或单独变更清理。

## Process Recovery 设计

### 问题

`SessionRunner` 的 active run 信息是内存态：

```text
activeRuns: Map<string, ActiveRun>
```

进程重启后这个 Map 会丢失，但 DB 里可能仍有：

```text
sessions.status = executing
agent_runs.status = running
messages.status = running
tool_parts.state.status in ('pending', 'running')
tool_calls.status in ('pending', 'pending_approval', 'approved', 'running')
```

如果不处理，session 可能永久停在 `executing`，但实际上没有 agent 在运行。

### 目标策略

第一阶段采用保守 recovery：

```text
不自动重新执行模型
不自动重新执行工具
不重复执行 write_file
不重复执行 run_command
只把重启前遗留的 open state 收敛成 interrupted/blocked/idle
```

### 启动流程

server 启动时，在开始监听请求前执行：

```text
main.ts
  -> recoverInterruptedSessionsOnStartup()
  -> serve(...)
```

如果 recovery 失败，第一阶段建议 server 仍可启动，但必须输出 error log，并追加可诊断信息。后续可以加严格模式环境变量：

```text
RECOVERY_STRICT=true
```

严格模式下 recovery 失败则拒绝启动。

### Recovery 扫描范围

需要扫描：

```text
sessions where status in ('executing', 'waiting_approval')
agent_runs where status in ('running', 'waiting_approval')
messages where status = 'running'
message_parts where type = 'tool' and state.status in ('pending', 'running')
tool_calls where status in ('pending', 'pending_approval', 'approved', 'running')
approvals where status = 'pending'
```

注意：`message_parts.state.status` 当前存储在 `message_parts.data_json` 中，不是独立 DB column。实现时不要假设可以直接用普通 SQL column filter；第一阶段应优先按 open run 扫描 message parts，再在应用层解析 JSON 判断 tool part 是否 open。

第一阶段可以以 open run 为主线扫描：

```text
agent_runs.status in ('running', 'waiting_approval')
  -> session
  -> messages/tool_parts/tool_calls/approvals by run_id
```

还需要扫描没有 active run 但 session 仍是 `executing` 的孤儿 session：

```text
sessions.status = executing
  -> no open agent_run
  -> mark session idle with lastErrorText
```

### Recovery 分类顺序

startup recovery 必须先分类，再收敛。不能直接复用现有 cancel/interrupt 清理路径。

必须按以下顺序处理每个 session：

```text
1. 读取 session 下所有 open runs。
2. 如果存在多个 open runs，记录 multiple_open_runs 诊断，并把这些 run 全部纳入同一个 session recovery 决策。
3. 对每个 waiting_approval run 先执行严格 waiting approval checkpoint 校验。
4. 校验有效的 waiting_approval run 保持原状态，不能 reject approval，不能 fail tool_call。
5. 只有确认不是有效 waiting approval 的 running/interrupted run，才能执行 open state interrupt。
6. 如果任一 waiting approval 校验失败且无法安全归类为 interrupted running run，session 进入 blocked。
7. 如果所有 open run 都可安全收敛为 interrupted，session 回到 idle。
```

禁止在分类前调用现有的：

```text
AgentRunService.cancelCurrentRun(...)
AgentRunService.interruptOpenState(...)
approvalRepository.rejectPendingByRun(...)
toolCallRepository.failOpenByRun(...)
```

原因：这些路径会无条件 reject pending approvals 和 fail open tool calls，可能误伤有效 `waiting_approval` checkpoint。

### waiting_approval policy

`waiting_approval` 是唯一允许跨进程保留的暂停态。

如果满足严格校验：

```text
session.status = waiting_approval
agent_run.status = waiting_approval
checkpoint.kind = waiting_approval
approval.status = pending
tool_call.status = pending_approval
tool_part.state.status = pending
checkpoint.approvalId/toolCallId/partId 能互相对应
```

startup recovery 的 waiting approval 校验必须使用 `tool_call.status = pending_approval`。虽然当前 HTTP resume 校验函数可能兼容 `pending`，startup recovery 不应放宽到 `pending`，因为新写入的 approval-required tool call 应持久化为 `pending_approval`。

则保持：

```text
session.status = waiting_approval
agent_run.status = waiting_approval
```

如果校验失败，则进入：

```text
agent_run.status = blocked
session.status = blocked
session.lastErrorText = Invalid waiting approval checkpoint during startup recovery.
```

进入 `session.blocked` 时，第一阶段保留 `session.lastCheckpointJson`，作为诊断和后续人工/专门 recovery 的依据。不要在 invalid waiting approval recovery 中清空 checkpoint，除非后续实现了专门的 checkpoint archive/event metadata。

不要自动 reject approval，除非能确定它属于已被中断的 running run。原因是用户可能正在审批界面，误 reject 会丢失可恢复状态。

### executing/running policy

对于重启前处于 `executing` 或 `agent_run.running` 的 session：

1. running assistant message 标记为 `cancelled`。
2. pending/running tool part 标记为 `error(reason = 'interrupted')`。
3. open tool_call 标记为 `failed`。
4. pending approval 如属于 running run 且不处于有效 waiting checkpoint，标记为 `rejected`，reason 使用 startup interrupted。
5. agent_run 标记为 `blocked`。
6. session 标记为 `idle`。
7. session.lastCheckpoint 清空。
8. session.lastErrorText 记录启动恢复信息。
9. 追加 `run.blocked` 事件。
10. 追加 `session.updated` 事件。

推荐第一阶段使用：

```text
agent_run.status = blocked
session.status = idle
```

原因：进程重启不是用户主动取消，也不是业务失败；但 run 确实不能继续。session 已经被收敛到安全状态后，应允许用户继续输入。

推荐错误文本：

```text
Previous run was interrupted by server restart.
```

如果 running run 中存在 assistant message 已经写入部分 text 或 interrupted tool result，第一阶段保留这些 message/part 在上下文中。下一轮 ContextBuilder 可以继续把它们作为历史上下文喂给模型，让模型看到上一次执行被中断的事实。不要在 recovery 中删除或隐藏这些 message。

如果同一个 session 存在多个 open runs，第一阶段处理策略：

```text
1. 记录诊断 multiple_open_runs。
2. 对所有可安全归类为 interrupted 的 open run 标记 run.blocked。
3. 对每个 run 分别收敛 running assistant message、open tool part、open tool_call 和 pending approval。
4. 如果没有无效 waiting approval checkpoint，session 回到 idle。
5. 如果存在无效 waiting approval checkpoint 或 run/session/checkpoint 互相矛盾，session 进入 blocked。
6. session.lastErrorText 必须包含 multiple open runs 诊断信息。
```

### blocked/failed/completed policy

启动 recovery 不自动处理这些 session：

```text
blocked
completed
archived
idle
planning
```

`failed` 会被 schema 移除。迁移后历史 `failed` 应变成：

```text
idle + lastErrorText
```

### 为什么不自动继续 RunLoop

不能盲目自动恢复执行，原因是副作用工具不具备 exactly-once 语义。

风险包括：

```text
write_file 可能已经写成功，但 DB 没记录 tool.completed
write_file 可能写到一半，文件状态未知
run_command 可能已经启动并修改 workspace
approval 可能 approved，但 tool result 未持久化
模型流可能部分写入 message，但 message 仍是 running
```

因此第一阶段只做收敛，不做重放。

## 新增 service 设计

建议新增：

```text
apps/server/src/services/session/recovery-service.ts
```

职责：

1. 提供 server startup recovery 用例。
2. 扫描 open run 和 stale executing session。
3. 校验 waiting approval checkpoint。
4. 调用 repositories 收敛 running message/tool/approval/run/session。
5. 协调 recovery events 的事务写入和 live publish。
6. 不直接启动 RunLoop。

建议 API：

```ts
export const sessionRecoveryService = {
  recoverInterruptedSessionsOnStartup(): StartupRecoveryReport;
};
```

`sessionRecoveryService` 只负责编排和分类策略，不应直接复用用户取消 run 的 service 路径。用户取消和 startup recovery 的语义不同：用户取消可以 reject pending approval；startup recovery 必须先保护有效 waiting approval。

## 新增 recovery repository 设计

建议新增专用 repository：

```text
apps/server/src/repositories/session-recovery-repository.ts
```

职责：

1. 提供 startup recovery 需要的全局扫描查询。
2. 提供按 session/run 粒度的事务性收敛写入。
3. 在同一个事务中更新 `agent_runs`、`messages`、`message_parts`、`tool_calls`、`approvals`、`sessions` 和 `session_events`。
4. 返回 recovery 后的 DTO 和需要 live publish 的 event envelopes。
5. 不调用 service，不启动 RunLoop，不发送 HTTP/SSE。

建议 API：

```ts
export const sessionRecoveryRepository = {
  listSessionsWithOpenRuns(): StartupRecoverySessionCandidate[];
  listStaleExecutingSessions(): SessionDto[];
  recoverInterruptedRuns(input: RecoverInterruptedRunsInput): RecoverInterruptedRunsResult;
  blockInvalidWaitingApproval(input: BlockInvalidWaitingApprovalInput): BlockInvalidWaitingApprovalResult;
};
```

`recoverInterruptedRuns(...)` 必须在一个事务中完成：

```text
1. mark selected open runs -> blocked
2. cancel running assistant messages
3. interrupt pending/running tool parts
4. fail open tool_calls
5. reject pending approvals only for runs classified as interrupted, never for valid waiting_approval
6. update session -> idle or blocked
7. append run/session/tool/message/approval/session.recovered events
```

`blockInvalidWaitingApproval(...)` 必须在一个事务中完成：

```text
1. mark run -> blocked
2. update session -> blocked
3. preserve session.lastCheckpointJson
4. set session.lastErrorText
5. append run.blocked/session.updated/session.recovered events
```

如果 `recoverInterruptedRuns(...)` 的输入包含同一 session 下多个 open run，这些 run 应放在同一个 session recovery 事务里处理。不要为同一个 session 的多个 open run 分别开多个互相独立的事务，否则可能出现部分 open run 已收敛、session 状态却按另一个 run 决定的半恢复。

事务完成后，`sessionRecoveryService` 负责把 repository 返回的 envelopes 发布到 `sessionStreamHub`。如果当前 event service 无法在外部事务中 append event，需要为 recovery repository 提供不会嵌套事务的 event append 内部函数，或者让 repository 直接写 `session_events` 并返回 envelope。

返回：

```ts
type StartupRecoveryReport = {
  blockedRuns: number;
  blockedSessions: number;
  interruptedRuns: number;
  multipleOpenRunSessions: number;
  recoveredAt: string;
  staleExecutingSessions: number;
  waitingApprovalsKept: number;
};
```

## Repository 能力补齐

当前已有按 run 清理的局部方法：

```text
messageRepository.cancelRunningByRun(...)
messagePartRepository.interruptOpenToolPartsByRun(...)
toolCallRepository.failOpenByRun(...)
agentRunRepository.getActiveBySession(...)
```

这些方法可以作为实现参考，但 startup recovery 不应直接调用现有 cancel/interrupt service 路径，也不应在分类前调用会 reject approval / fail tool_call 的方法。

还需要补全全局扫描方法：

```text
sessionRepository.listByStatuses(statuses)
agentRunRepository.listOpen()
agentRunRepository.listOpenByStatus(status)
messageRepository.listRunningByRun(runId)
messagePartRepository.listOpenToolPartsByRun(runId)
toolCallRepository.listOpenByRun(runId)
approvalRepository.listPendingByRun(runId)
```

可能还需要补充：

```text
approvalRepository.rejectPendingByRun(...)
```

如果已有方法可复用，不要重复实现。

当前已有的方法包括：

```text
messageRepository.listRunningByRun(...)
messagePartRepository.listOpenToolPartsByRun(...)
toolCallRepository.listOpenByRun(...)
approvalRepository.listPendingByRun(...)
approvalRepository.rejectPendingByRun(...)
```

真正必须补充的是：

```text
sessionRepository.listByStatuses(...)
agentRunRepository.listOpen(...)
agentRunRepository.listOpenByStatus(...)
sessionRecoveryRepository 的事务性恢复方法
```

Repository 只做 DB 读写，不写 recovery 策略，不追加 session event。

例外：`sessionRecoveryRepository` 是专用事务 repository，可以在事务内追加 recovery 需要的 `session_events`，但不负责决定 recovery 策略，不负责 publish live event。

## 事件设计

当前可复用的现有事件：

```text
run.failed
run.cancelled
message.cancelled
tool.failed
approval.resolved
session.updated
```

本 RFC 目标新增事件：

```text
run.blocked
session.recovered
```

必须移除：

```text
session.failed
```

移除 `session.failed` 包括：

1. `SessionEvent` union 删除 `session.failed`。
2. `Lifecycle.handleFailure()` 普通失败不再追加 `session.failed`。
3. `context_too_large` / session blocked 不再追加 `session.failed`。
4. `sessionEventService` 删除 `session.failed` metadata 分支。
5. `sessionEventRepository` parse fallback 不再构造 `session.failed`，改为 `session.updated` 或专门的 parse error fallback。
6. 前端不再依赖 `session.failed` 事件展示普通错误。

新增事件：

```text
session.recovered
```

事件语义：

```ts
type SessionRecoveredEvent = {
  diagnostics?: string[];
  interruptedRunIds: string[];
  keptWaitingApprovalRunIds?: string[];
  reason:
    | 'invalid_waiting_approval_checkpoint'
    | 'multiple_open_runs'
    | 'server_startup_recovery'
    | 'stale_executing_session';
  recoveredAt: string;
  sessionId: string;
  type: 'session.recovered';
};
```

`run.blocked` 建议结构：

```ts
type RunBlockedEvent = {
  error: string;
  run: AgentRunDto;
  sessionId: string;
  type: 'run.blocked';
};
```

如果 Phase 1 不想扩 shared event，可以先用：

```text
run.failed + session.updated
```

但 Phase 3 必须新增 `session.recovered`，因为它比 `session.failed` 更准确。

同时必须新增：

```text
run.blocked
```

当前可以临时用 `run.failed` 携带 blocked run，但长期不准确。若 Phase 1 不想扩展事件 union，可以先只保证完全停止发 `session.failed`，然后在 Phase 3 引入 `run.blocked` 和 `session.recovered`。

## 启动接线

文件：`apps/server/src/main.ts`

目标结构：

```ts
import { sessionRecoveryService } from './services/session/recovery-service.js';

const report = sessionRecoveryService.recoverInterruptedSessionsOnStartup();
console.log('Startup recovery completed', report);

serve(...);
```

如果 recovery 需要异步，改成：

```ts
async function main() {
  const report = await sessionRecoveryService.recoverInterruptedSessionsOnStartup();
  console.log('Startup recovery completed', report);
  serve(...);
}

void main();
```

当前 DB/repository 大多是同步 SQLite API，第一阶段可以保持同步。

## 实施顺序

必须按以下顺序推进。

### Phase 1: 移除 session failed

1. 修改 `packages/shared/src/contracts.ts`，从 `sessionStatusSchema` 移除 `failed`。
2. 修改 `packages/db/schema/sessions.lt.hcl`，从 check 中移除 `failed`。
3. 当前开发阶段可删除本地 SQLite 数据库并重建；如果需要保留数据，再生成 migration 把历史 `sessions.status = 'failed'` 迁移到 `idle`。
4. 运行 `pnpm db:sync` 更新 ORM。
5. 修改 `Lifecycle.handleFailure()`，普通失败后 session 回到 `idle`。
6. 移除 `session.failed` 事件类型和所有追加/展示分支。
7. 修改前端和测试中对 `session.status = failed` 的依赖。
8. 保留 `agent_run.status = failed`。

### Phase 2: 拆清 blocked 语义

1. 明确 `agent_run.blocked` 表示 run 级阻塞。
2. 明确 `session.blocked` 表示 session 级阻塞。
3. `context_too_large_compact_not_implemented` 继续使用 `session.blocked`。
4. 普通 provider/model/tool runtime failure 不再写 `session.blocked`。
5. waiting approval checkpoint 不一致写 `session.blocked`。
6. 更新 UI 文案，把 idle + lastErrorText 和 blocked 区分展示。
7. 新增 `run.blocked` 事件，或至少在 Phase 3 前完成新增。

### Phase 3: Startup process recovery

1. 新增 repository 扫描方法。
2. 新增 `sessionRecoveryRepository`，提供事务性 startup recovery 写入。
3. 新增 `sessionRecoveryService`，负责分类、校验和调用 recovery repository。
4. 实现 waiting approval 严格校验并保持可恢复状态。
5. 实现 executing/running interrupted 收敛。
6. 实现同一 session 多 open run 的全部收敛和诊断记录。
7. 接入 `apps/server/src/main.ts`。
8. 增加 server tests 覆盖 startup recovery。
9. 新增 `session.recovered` 事件。

## 测试建议

### Unit tests

需要覆盖：

1. 普通 `Lifecycle.handleFailure()` 后 `run.failed` 且 `session.idle`。
2. 普通失败不追加 `session.failed` 事件。
3. `context_too_large` 后 `run.blocked` 且 `session.blocked`。
4. `context_too_large` 不追加 `session.failed` 事件。
5. 历史 `failed` migration 后变成 `idle`，如果保留数据迁移。
6. startup recovery 保留有效 `waiting_approval`，且不 reject pending approval。
7. startup recovery 要求有效 waiting approval 的 `tool_call.status = pending_approval`。
8. startup recovery 阻塞无效 `waiting_approval`，并保留 checkpoint。
9. startup recovery 收敛 `executing + running run`。
10. startup recovery 收敛同一 session 多 open runs，并记录诊断。
11. startup recovery 修复 running assistant message。
12. startup recovery interrupt pending/running tool part。
13. startup recovery fail open tool call。
14. startup recovery 不重复执行 `write_file` 和 `run_command`。

### Integration tests

建议增加 server 级测试：

```text
create session
create running run
create running assistant message
create running tool part
call recoverInterruptedSessionsOnStartup()
assert session.status = idle
assert run.status = blocked
assert message.status = cancelled
assert tool part state.status = error
assert tool part state.reason = interrupted
assert tool call.status = failed
assert session event includes session.recovered
assert session event includes session.updated
```

### 验证命令

```bash
pnpm --filter @opencode/server typecheck
pnpm --filter @opencode/server test
pnpm --filter @opencode/agent typecheck
pnpm --filter @opencode/web typecheck
pnpm typecheck
```

## 兼容与迁移

当前阶段可以删除本地 SQLite 数据库并按新 schema 重建，不要求保留本地历史数据。

如果需要保留任何共享环境或用户数据，历史 `session.status = failed` 数据必须迁移。

推荐迁移：

```sql
UPDATE sessions
SET status = 'idle',
    last_error_text = COALESCE(last_error_text, 'Session was migrated from failed to idle.'),
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'failed';
```

注意 SQLite migration 中 `CURRENT_TIMESTAMP` 格式可能与项目 ISO 字符串不一致。生成 migration 后需要 review，必要时使用应用层迁移或固定字符串。

如果移除 check constraint 需要 SQLite table rebuild，必须在进入新 check 前转换 `failed`。允许的方式：

```sql
CASE WHEN status = 'failed' THEN 'idle' ELSE status END
```

也可以在 rebuild 前先执行 data migration。不能直接 `INSERT INTO new_sessions SELECT status ...`，否则历史 `failed` 会违反新的 check constraint。

如果 migration 需要 rebuild `sessions` 表，必须确认：

```text
failed -> idle
last_error_text 被保留或补齐
last_checkpoint_json 不被误删
foreign key 不丢失
index/check 被重建
```

## 失败处理策略

Recovery 本身失败时，第一阶段建议：

```text
记录 error log
继续启动 server
保留原 DB 状态
```

但如果部分 recovery 已经写入 DB 后失败，会造成半恢复。为避免这个问题，`sessionRecoveryService` 应通过 `sessionRecoveryRepository` 按 run/session 粒度使用事务。

推荐事务边界：

```text
one session recovery = one transaction
one invalid waiting approval recovery = one transaction
one stale executing session recovery = one transaction
```

不要把全库 recovery 放进一个巨大事务，避免一个坏 session 阻塞全部 recovery。

## 后续扩展

本 RFC 完成后，可以继续做：

1. `POST /api/sessions/:sessionId/recover` 手动恢复接口。
2. `POST /api/sessions/:sessionId/reset-runtime-state` 安全解除 stale runtime 状态。
3. `POST /api/sessions/:sessionId/compact` 解除 context too large。
4. `fork session`，从历史消息中复制安全上下文开新 session。
5. Queue + Worker，使 process recovery 从“启动修复”升级为“任务重派/中断恢复”。
6. 对只读工具 `read_file` 探索自动恢复执行，但仍不自动重放副作用工具。

## 最终结论

Session 层不应保留常规 `failed` 状态。

失败应该归属到 `agent_run.failed`，并通过 `session.lastErrorText` 告诉用户上一轮失败原因。session 默认应回到 `idle`，让用户能继续输入。

`session.blocked` 应只用于真正需要恢复动作的 session 级阻塞，例如 context too large、invalid checkpoint 或无法安全收敛的数据不一致。

Process recovery 第一阶段必须保守：启动时扫描并收敛旧的 running/executing 状态，但不自动重复执行模型、`write_file` 或 `run_command`。
