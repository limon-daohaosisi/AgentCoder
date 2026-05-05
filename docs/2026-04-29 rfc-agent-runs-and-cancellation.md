# RFC: Agent Runs 与 Run Cancellation 链路

日期：2026-04-29

状态：Draft

目标读者：人类维护者、coding agent

## 背景

当前系统已经有 `sessions`、`messages`、`message_parts`、`tool_calls`、`approvals`、`session_events`。这些表可以记录一次 agent 执行过程中产生的内容，但还没有一个持久化实体表示“一次执行过程本身”。

现在运行态依赖 `apps/server/src/services/agent/runner.ts` 中的内存 `activeRuns: Set<string>`。它只能阻止同一个 session 并发执行，不能记录 run 生命周期，也不能取消正在运行的模型 stream 或工具执行。

本 RFC 设计新增 `agent_runs` 表，并打通“取消当前 run，但不取消 session”的链路。

## 术语

1. `Session`：一个长期会话/任务容器，对应 `sessions` 表。
2. `Run`：用户发出一条触发 agent 执行的消息后，模型从开始处理到停下来的那一轮执行。
3. `Message`：用户或 assistant 的对话记录，是 run 的产物。
4. `MessagePart`：message 内部的 text/reasoning/tool/file/patch 等片段。
5. `ToolCall`：run 过程中一次工具调用记录。
6. `Approval`：run 暂停等待人工确认的一次决策。
7. `SessionEvent`：session/run 过程中发生的事实事件，用于时间线、SSE、调试。

## 目标

1. 新增持久化 `agent_runs` 表，让每一次 agent 执行有明确身份和生命周期。
2. 新增 `SessionStatus = 'idle'`，表达 session 当前没有 active run 且可以继续输入。
3. 新增取消当前 run 的 HTTP API，而不是取消整个 session。
4. 使用 `AbortController` 打断模型 stream、run loop、tool execution。
5. 取消后清理本 run 产生的 running/pending 状态，让 DB 保持可信。
6. 取消 run 后 session 进入 `idle`，用户后续说“继续”会创建新的 user message 和新的 run。
7. 保持当前架构分层：routes 只转发，services 编排，repositories 只做 DB，packages/agent 不依赖 server。

## 非目标

1. 不取消整个 session，不新增 `SessionStatus = 'cancelled'`。
2. 不支持同一个 session 并发多个 active run。
3. 不在第一版实现完整后台队列。
4. 不在第一版实现 run retry UI。
5. 不把 cancellation 当成系统失败处理。

## 当前代码现状

### Shared

1. `packages/shared/src/contracts.ts` 中 `SessionStatus` 缺少 `idle`。
2. `packages/shared/src/dto.ts` 中 `MessageStatus` 已有 `cancelled`。
3. `packages/shared/src/dto.ts` 中 `ToolState.reason` 已有 `interrupted`。
4. `packages/shared/src/events.ts` 还没有 `run.created`、`run.completed`、`run.cancelled`、`message.cancelled`。

### DB / ORM

1. `packages/db/schema/sessions.lt.hcl` 的 session status check 不包含 `idle`。
2. `packages/orm/src/schema.ts` 的 `sessions` check 不包含 `idle`。
3. 当前没有 `agent_runs` 表。
4. `messages`、`tool_calls`、`approvals`、`session_events` 没有 `run_id`。

### Server

1. `apps/server/src/services/agent/runner.ts` 只有 `Set<string>`，没有 `AbortController`。
2. `apps/server/src/routes/agent/agent.route.ts` 只有 `POST /:sessionId/messages` 和 `GET /:sessionId/stream`。
3. `apps/server/src/services/agent/interaction-service.ts` 在 prompt 时直接把 session 设为 `executing`，但没有 run 记录。
4. `apps/server/src/services/session/resume-service.ts` 只围绕 session checkpoint 判断 approval resume。
5. repositories 没有按 runId 查询或清理 open 状态的方法。

### Agent Core

1. `packages/agent/src/lifecycle.ts` 没有接收 `AbortSignal` 或 `runId`。
2. `packages/agent/src/run-loop.ts` 没有接收 `AbortSignal` 或 `runId`。
3. `packages/agent/src/session-processor.ts` 没有接收 `AbortSignal` 或 `runId`。
4. `packages/agent/src/model-client.ts` 调 `streamText()` 时没有传 abort signal。
5. `packages/agent/src/tool-executor.ts` 工具执行没有统一 cancellation。
6. `packages/agent/src/tools/run-command.ts` 只支持 timeout kill，不支持 user abort kill。

## 设计原则

1. `session.status` 表达当前会话可操作状态。
2. `agent_runs.status` 表达一次执行实例的生命周期。
3. `message/part/tool/approval` 是 run 的产物，新增 `run_id` 归属到 run。
4. `run cancellation` 只中断当前 run，不归档、不失败、不取消 session。
5. 用户取消 run 后，session 应回到 `idle`。
6. 等待 approval 时取消 run，不 resume agent，不执行工具。
7. `packages/agent` 只接收 `runId`、`AbortSignal` 和 deps，不 import server repository。

## 状态模型

### SessionStatus

新增：

```ts
type SessionStatus =
  | 'planning'
  | 'idle'
  | 'executing'
  | 'waiting_approval'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'archived';
```

含义：

1. `planning`：session 刚创建或仍在初始规划阶段。
2. `idle`：没有 active run，可以接受新的 user message。
3. `executing`：当前有 active run 正在执行。
4. `waiting_approval`：当前 run 暂停在 approval。
5. `blocked`：系统性问题阻塞，例如 context too large。
6. `failed`：session 发生不可恢复错误。
7. `completed`：session 任务整体完成。
8. `archived`：session 已归档。

推荐转换：

```text
planning -> executing       用户第一次提交消息/目标开始执行
idle -> executing           用户继续提交消息
executing -> idle           run 正常结束，但 session 仍可继续
executing -> waiting_approval run 暂停等待审批
waiting_approval -> executing approval approve/reject 后 resume 同一个 run
executing -> idle           用户取消当前 run
waiting_approval -> idle    用户取消暂停中的 run
executing -> blocked        context too large 等可处理阻塞
executing -> failed         不可恢复错误
idle -> archived            用户归档
```

### AgentRunStatus

新增：

```ts
type AgentRunStatus =
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'blocked';
```

含义：

1. `running`：run 正在执行。
2. `waiting_approval`：run 暂停等待 approval。
3. `completed`：run 正常结束。
4. `cancelled`：用户取消当前 run。
5. `failed`：run 失败。
6. `blocked`：run 因 context too large 等原因阻塞。

## 数据库设计

### 新表：agent_runs

HCL 文件：`packages/db/schema/agent-runs.lt.hcl`

建议字段：

```text
id text primary key not null
session_id text not null references sessions(id) on delete cascade
trigger_message_id text null references messages(id) on delete set null
status text not null
started_at text not null
ended_at text null
cancelled_at text null
error_text text null
last_checkpoint_json text null
created_at text not null
updated_at text not null
```

Check：

```text
status IN ('running', 'waiting_approval', 'completed', 'cancelled', 'failed', 'blocked')
```

Indexes：

```text
idx_agent_runs_session_created_at(session_id, created_at)
idx_agent_runs_session_status(session_id, status)
idx_agent_runs_trigger_message_id(trigger_message_id)
```

`trigger_message_id` 必须允许 `null`，因为第一版采用以下创建顺序：

```text
1. 创建 agent_run，trigger_message_id = null。
2. 创建 user message，messages.run_id = agent_run.id。
3. 回填 agent_run.trigger_message_id = user message id。
```

不要反过来先创建 user message 再创建 run，否则 `messages.run_id` 和 `agent_runs.trigger_message_id` 会互相等待，agent 容易实现出不一致的半绑定状态。

### 新增 run_id 外键

建议给这些表添加 nullable `run_id`：

1. `messages.run_id`，references `agent_runs(id)` on delete set null。
2. `message_parts.run_id`，references `agent_runs(id)` on delete set null。
3. `tool_calls.run_id`，references `agent_runs(id)` on delete set null。
4. `approvals.run_id`，references `agent_runs(id)` on delete set null。
5. `session_events.run_id`，references `agent_runs(id)` on delete set null。

为什么 nullable：

1. 历史数据没有 run。
2. 有些系统事件可能不属于具体 run。
3. 分阶段迁移更安全。

Indexes：

```text
idx_messages_run_created_at(run_id, created_at)
idx_message_parts_run_order(run_id, order_index)
idx_tool_calls_run_status(run_id, status)
idx_approvals_run_status(run_id, status)
idx_session_events_run_sequence(run_id, sequence_no)
```

### sessions.status check

更新 `packages/db/schema/sessions.lt.hcl`：

```text
status IN ('planning', 'idle', 'executing', 'waiting_approval', 'blocked', 'failed', 'completed', 'archived')
```

### Migration 工作流

必须遵守 `packages/db/AGENTS.md`：

1. 先改 `packages/db/schema/*.lt.hcl`。
2. 运行 `atlas migrate diff <name> --env local`。
3. review SQL，特别是 SQLite table rebuild。
4. 如手工改 SQL，运行 `atlas migrate hash --dir "file://migrations"`。
5. 运行 `pnpm db:sync` 更新 ORM。
6. 不要编辑已存在 migration。

## Shared Contract 变更

文件：`packages/shared/src/contracts.ts`

1. `sessionStatusSchema` 增加 `idle`。
2. 新增 `agentRunStatusSchema`。
3. 新增 cancel run input 如需要 reason：

```ts
export const cancelRunInputSchema = z.object({
  reason: z.string().trim().min(1).optional()
});
```

文件：`packages/shared/src/dto.ts`

新增：

```ts
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export type AgentRunDto = {
  cancelledAt?: string;
  createdAt: string;
  endedAt?: string;
  errorText?: string;
  id: string;
  lastCheckpointJson?: string;
  sessionId: string;
  startedAt: string;
  status: AgentRunStatus;
  triggerMessageId?: string;
  updatedAt: string;
};

export type CancelRunResponse = {
  cancelled: boolean;
  reason: 'active_run_cancelled' | 'approval_cancelled' | 'no_active_run';
  run?: AgentRunDto;
  session: SessionDto;
};
```

给这些 DTO 增加可选 `runId?: string`：

1. `MessageDto`
2. `ToolCallDto`
3. `ApprovalDto`

不要给 `MessagePart.PartBase` 增加 `runId`。`message_parts.run_id` 第一版只作为数据库列和 repository 查询条件，不写入 `message_parts.data_json`。`messagePartRepository` mapper 不需要把 row.run_id 注入 part JSON，避免同一信息在列和 JSON 中双写漂移。

`ApprovalDto` 还需要补充这些字段，以支持 cancellation decision reason 和后续 UI/debug：

```ts
decisionReasonText?: string;
decisionScope?: 'once' | 'session_rule';
decidedBy?: string;
runId?: string;
suggestedRuleJson?: string;
taskId?: string;
```

文件：`packages/shared/src/events.ts`

新增事件：

```ts
| { type: 'run.created'; sessionId: string; run: AgentRunDto }
| { type: 'run.completed'; sessionId: string; run: AgentRunDto }
| { type: 'run.cancelled'; sessionId: string; run: AgentRunDto; reason: string }
| { type: 'run.failed'; sessionId: string; run: AgentRunDto; error: string }
| { type: 'message.cancelled'; sessionId: string; messageId: string; runId?: string }
```

第一版不要给 `SessionEventEnvelope` 顶层增加 `runId`。推荐在 `session_events.run_id` 保存关系，并在具体 event payload 中携带需要展示的 run 信息，避免前端大改。

同时更新 `apps/server/src/services/session-events/event-service.ts` 的 `deriveCreatedAt` 和 `deriveMetadata`，让 `run.created`、`run.completed`、`run.cancelled`、`run.failed`、`message.cancelled` 能生成正确的 `entityType/entityId/headline/detailText/level`，不要退化成默认 session metadata。

## Repository 变更

新增：`apps/server/src/repositories/agent-run-repository.ts`

职责：只做 DB 访问和 row -> `AgentRunDto` 映射，不做业务判断。

建议方法：

```ts
create(input): AgentRunDto
getById(id): AgentRunDto | null
getActiveBySession(sessionId): AgentRunDto | null
listBySession(sessionId): AgentRunDto[]
setTriggerMessage(input): AgentRunDto | null
markWaitingApproval(input): AgentRunDto | null
markRunning(input): AgentRunDto | null
markCompleted(input): AgentRunDto | null
markCancelled(input): AgentRunDto | null
markFailed(input): AgentRunDto | null
markBlocked(input): AgentRunDto | null
```

Open status：

```text
running
waiting_approval
```

更新现有 repositories：

1. `message-repository.ts`
   - create input 支持 `runId?: string | null`。
   - mapper 返回 `runId`。
   - 新增 `listRunningByRun(runId)` 或 `listOpenByRun(runId)`。
2. `message-part-repository.ts`
   - create input 支持 `runId?: string | null`。
   - mapper 不把 `runId` 写入或注入 `MessagePart` JSON。
   - 新增 `listOpenToolPartsByRun(runId)`。
3. `tool-call-repository.ts`
   - create input 支持 `runId?: string | null`。
   - mapper 返回 `runId`。
   - 新增 `listOpenByRun(runId)`。
4. `approval-repository.ts`
   - create input 支持 `runId?: string | null`。
   - mapper 返回 `runId`。
   - 新增 `listPendingByRun(runId)`。
   - `updateDecision` 支持 `decisionReasonText`，并把 `decisionReasonText/decisionScope/decidedBy/suggestedRuleJson/taskId/runId` 映射到 `ApprovalDto`。
5. `session-event-repository.ts`
   - append input 支持 `runId?: string | null`。
   - 可按 runId 建索引，但 stream 仍按 session sequence。

## Services 变更

### 新增 service：agent run service

建议文件：`apps/server/src/services/agent/run-service.ts`

职责：编排 run 创建、完成、失败、取消。

建议方法：

```ts
createRun(input: {
  sessionId: string;
}): AgentRunDto

setTriggerMessage(input: {
  runId: string;
  triggerMessageId: string;
}): AgentRunDto | null

cancelCurrentRun(input: {
  reason?: string;
  sessionId: string;
}): CancelRunResponse

completeRun(input: {
  runId: string;
  sessionId: string;
}): AgentRunDto | null

failRun(input: {
  errorText: string;
  runId: string;
  sessionId: string;
}): AgentRunDto | null

pauseRunForApproval(input: {
  checkpoint: SessionCheckpoint;
  runId: string;
  sessionId: string;
}): AgentRunDto | null
```

### interaction-service prompt 流程

当前位置：`apps/server/src/services/agent/interaction-service.ts`

目标流程：

```text
1. 查 session。
2. 第一版只允许 planning/idle 状态提交 prompt，禁止 executing/waiting_approval/blocked/failed/completed/archived。
3. runner.ensureRunning(sessionId, setup, run)。
4. setup 内先创建 agent_run，trigger_message_id = null。
5. 创建 user message，message.runId = agent_run.id。
6. 回填 agent_run.trigger_message_id = user message id。
7. append run.created/message.created/session.updated。
8. session.status = executing，lastErrorText = null，lastCheckpoint = null。
9. run callback 调 lifecycle.startPromptRun({ sessionId, runId, signal })。
10. lifecycle 负责根据 completed/cancelled/failed/blocked/paused_for_approval 标记 run/session 最终状态。
```

终态更新所有权：

```text
Lifecycle 是 run 终态更新的唯一所有者。
interaction-service 只负责创建 run、创建 user message、启动 background run。
cancel service 可以发 abort 和做即时幂等清理，但不能在 lifecycle 之后覆盖 completed/failed/cancelled 终态。
agent-run-repository 的终态更新必须带 open status 条件，只允许 running/waiting_approval -> completed/cancelled/failed/blocked。
```

注意：不要让 route 创建 run。

### approval resolve 流程

当前 approval resolve 是同一个 run 的 resume，不应创建新 run。

目标流程：

```text
1. 从 approval 或 toolCall 找到 runId。
2. assert approval resume ready。
3. runner.ensureRunning(sessionId, setup, run)。
4. setup 内更新 approval decision，append approval.resolved。
5. agent_run.status = running。
6. session.status = executing。
7. run callback 调 lifecycle.resumeApprovalRun({ approval, decision, toolCall, runId, signal })。
```

### cancelCurrentRun 流程

API 语义：取消当前 run，不取消 session。

建议流程：

```text
1. 查 session，不存在返回 404。
2. 查当前 active run：优先 runner.getActiveRun(sessionId)，否则 repository.getActiveBySession(sessionId)。
3. 如果没有 active/waiting_approval run：返回 { cancelled: false, reason: 'no_active_run', session }。
4. 调 runner.cancel(sessionId)，如果有内存 active run，会触发 AbortController。
5. 如果 run.status === waiting_approval 或 session.status === waiting_approval：
   - 找到 runId 下 pending approvals。
   - approvals -> rejected，decisionReasonText = 'Run cancelled by user'。
   - 对应 tool parts -> error(reason='interrupted')。
   - 对应 tool calls -> failed。
6. 清理 runId 下 running assistant messages：status = cancelled，finishReason = cancelled。
7. 清理 runId 下 pending/running tool parts：state.status = error，reason = interrupted。
8. 清理 runId 下 pending/running/pending_approval tool calls：status = failed，errorText = 'Run cancelled by user'。
9. 请求 agent_run 从 open status 标记为 cancelled；如果 status 已不是 running/waiting_approval，则返回 no_active_run，不覆盖终态。
10. session.status = idle，lastCheckpoint = null，lastErrorText = null。
11. append run.cancelled、message.cancelled、tool.failed、approval.resolved、session.updated。
12. 返回 { cancelled: true, reason, run, session }。
```

竞态要求：

1. 如果 run 已刚好 completed，cancel 返回 `cancelled: false`、`reason: 'no_active_run'`，不要覆盖 completed 为 cancelled。
2. repository 更新应带 status 条件，只更新 open status。
3. 清理逻辑要幂等，重复 cancel 不应报 500。

这里的“清理”不是删除数据，而是把 open 状态终结为明确状态：running assistant message 变成 `cancelled`，pending/running tool part 变成 `error(reason='interrupted')`，pending/running tool call 变成 `failed`，pending approval 变成 `rejected`。所有历史记录必须保留，用于 timeline、debug 和下一轮 context。

## SessionRunner 设计

文件：`apps/server/src/services/agent/runner.ts`

当前：`Set<string>`。

目标：`Map<string, ActiveRun>`。

建议类型：

```ts
type ActiveRun = {
  controller: AbortController;
  runId: string;
  sessionId: string;
  startedAt: string;
};
```

建议 API：

```ts
busy(sessionId: string): boolean
getActiveRun(sessionId: string): ActiveRun | null
cancel(sessionId: string, reason?: string): boolean
ensureRunning<T>(
  sessionId: string,
  setup: () => Promise<{ ctx: T; runId: string }>,
  run: (ctx: T, signal: AbortSignal) => Promise<void>
): Promise<T>
```

实现规则：

1. `SessionRunner` 只负责内存运行控制和 abort signal，不写 DB。
2. active run 必须在 background run `finally` 中释放。
3. 如果 setup 失败，不能留下 active run。
4. cancel 只调用 `controller.abort()`，业务清理在 service。

## Agent Core 变更

### 通用输入

给这些输入增加 `runId` 和 `signal`：

1. `Lifecycle.startPromptRun`
2. `Lifecycle.resumeApprovalRun`
3. `RunLoop.run`
4. `SessionProcessor.processTurn`
5. `ToolExecutor.executePendingToolParts`
6. `ToolExecutor.executeApprovedPart`
7. `streamModelResponse`
8. `runCommandTool`

示例：

```ts
type RunLoopInput = {
  runId: string;
  sessionId: string;
  signal: AbortSignal;
  workspaceRoot: string;
};
```

### Result 类型

新增 `cancelled`：

```ts
type RunLoopResult =
  | { kind: 'completed'; finishReason: string }
  | { kind: 'paused_for_approval'; checkpoint?: unknown }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'failed'; error: string }
  | { kind: 'context_too_large'; error: string }
  | { kind: 'max_steps_exceeded' };
```

`ProcessorResult`、`ToolExecutorResult` 同样增加 `cancelled`。

### Abort 规则

1. 每个 loop step 开始前检查 `signal.aborted`。
2. 调模型前检查 `signal.aborted`。
3. stream 事件循环中捕获 abort error，返回 cancelled，不当成 failed。
4. tool 执行前后检查 `signal.aborted`。
5. cancellation 不应触发 `session.failed`。

### Lifecycle 终态职责

`Lifecycle` 负责把 `RunLoopResult` 转换成 run/session 终态：

```text
completed -> agent_runs.completed + sessions.idle + run.completed + session.updated
paused_for_approval -> agent_runs.waiting_approval + sessions.waiting_approval + session.resumable + session.updated
cancelled -> agent_runs.cancelled + sessions.idle + run.cancelled + session.updated
context_too_large -> agent_runs.blocked + sessions.blocked + run.failed/session.failed + session.updated
failed/max_steps_exceeded -> agent_runs.failed + sessions.failed + run.failed/session.failed + session.updated
```

`interaction-service` 不应在 background run 完成后再做第二套终态判断。`cancelCurrentRun` 可以先做清理和 abort，但最终状态更新仍必须通过带 status 条件的 lifecycle/repository 方法保证不会覆盖 completed/failed/cancelled。

### streamText signal

文件：`packages/agent/src/model-client.ts`

改 `StreamModelResponse` 签名：

```ts
export type StreamModelResponse = (
  request: AiSdkTurnRequest,
  options?: { signal?: AbortSignal }
) => ModelResponseStream;
```

调用 `streamText` 时传入当前 AI SDK 支持的 abort signal 参数。实现前请确认 `ai` 版本字段名，通常是 `abortSignal`。

### run_command cancellation

文件：`packages/agent/src/tools/run-command.ts`

改签名：

```ts
runCommandTool(input, workspaceRoot, options?: { signal?: AbortSignal })
```

规则：

1. spawn 前如果 signal aborted，直接抛 `Run cancelled by user`。
2. spawn 时优先使用可杀进程组的实现。Linux 下建议 `detached: true` 后通过 `process.kill(-child.pid, 'SIGTERM')` 终止 shell 及其子进程。
3. 如果进程组 kill 不可用，至少对 child 执行 `child.kill('SIGTERM')`，并在代码注释中标明可能无法杀掉 shell 孙进程。
4. 短暂 grace period 后如果仍未退出，对同一 pid/进程组发送 `SIGKILL`。
5. 返回/抛出 interrupted error，由 `ToolExecutor` 映射为 `ToolPart.state.reason = 'interrupted'`。

## DB 状态清理规则

取消 run 时只清理该 `run_id` 下 open 状态的数据。

### Messages

条件：

```text
run_id = current run id
role = assistant
status = running
```

更新：

```text
status = cancelled
finish_reason = cancelled
error_text = null 或 'Run cancelled by user'
updated_at = now
```

事件：

```text
message.cancelled
```

### ToolParts

条件：

```text
run_id = current run id
type = tool
state.status IN ('pending', 'running')
```

更新 part JSON：

```text
state.status = error
state.reason = interrupted
state.errorText = Run cancelled by user
state.payload = { ok: false, error: 'Run cancelled by user' }
state.completedAt = now
```

### ToolCalls

条件：

```text
run_id = current run id
status IN ('pending', 'pending_approval', 'running', 'approved')
```

更新：

```text
status = failed
error_text = Run cancelled by user
completed_at = now
updated_at = now
```

第一版统一 `tool_calls.status = failed`。不要在 cancellation 中使用 `tool_calls.status = rejected`；`rejected` 只用于 `approvals.status`，`ToolPart.state.reason` 用 `interrupted` 表达用户取消导致的中断。

事件：

```text
tool.failed
```

### Approvals

条件：

```text
run_id = current run id
status = pending
```

更新：

```text
status = rejected
decided_at = now
decision_reason_text = Run cancelled by user
```

事件：

```text
approval.resolved decision='rejected'
```

### Session

更新：

```text
status = idle
last_checkpoint_json = null
last_error_text = null
updated_at = now
```

事件：

```text
session.updated
```

### AgentRun

更新：

```text
status = cancelled
cancelled_at = now
ended_at = now
updated_at = now
error_text = null 或 cancel reason
last_checkpoint_json = null
```

事件：

```text
run.cancelled
```

## HTTP API

### Cancel current run

Route：

```text
POST /api/sessions/:sessionId/runs/current/cancel
```

Request body：

```json
{
  "reason": "optional reason"
}
```

Response：

```ts
CancelRunResponse;
```

Status：

1. `200`：请求已处理。即使没有 active run，也返回 `cancelled: false`，避免 UI 竞态报错。
2. `404`：session 不存在。
3. `409`：session archived 或其他不可操作状态。

Route 层只调用 service，不直接操作 runner/repository。

### Optional：list runs

可后续增加：

```text
GET /api/sessions/:sessionId/runs
```

第一版非必要。

## Frontend 变更

文件：`apps/web/src/lib/api.ts`

新增：

```ts
cancelCurrentRun(sessionId, input?)
```

文件：`apps/web/src/hooks/use-session-stream.ts`

新增事件名：

```text
run.created
run.completed
run.cancelled
run.failed
message.cancelled
```

收到这些事件后 invalidate：

```text
session
messages
resume-session
sessions list
```

UI：

1. 在 session status 为 `executing` 或 `waiting_approval` 时显示“取消当前运行”。
2. 取消成功后依赖 SSE 或 query refresh 显示 `idle`。
3. `idle` 状态下 composer 可输入。
4. `message.status = cancelled` 时显示“本轮回复已取消”。

## Testing Plan

### Unit / service tests

1. `SessionRunner`：
   - `ensureRunning` 创建 active run。
   - `cancel` aborts signal。
   - background run finally 释放 active run。
   - setup 失败不残留 active run。
2. `agentRunRepository`：
   - create/get/list/update status。
   - getActiveBySession 只返回 running/waiting_approval。
3. `cancelCurrentRun`：
   - no active run 返回 `cancelled: false`。
   - executing run 取消后 session -> idle，run -> cancelled。
   - running assistant message -> cancelled。
   - running tool -> interrupted/failed。
   - waiting approval run 取消后 approval -> rejected，session -> idle。
4. `RunLoop` / `SessionProcessor`：
   - signal aborted before model call 返回 cancelled。
   - signal aborted during stream 返回 cancelled。
5. `runCommandTool`：
   - signal abort kills child process。
   - shell 子进程树会被终止，不能只 kill shell 父进程。

### Route tests

1. `POST /api/sessions/:id/runs/current/cancel` session not found -> 404。
2. no active run -> 200 `{ cancelled: false }`。
3. active run -> 200 `{ cancelled: true }`。
4. SSE 收到 `run.cancelled` 和 `session.updated`。

### Typecheck

```bash
pnpm --filter @opencode/agent typecheck
pnpm --filter @opencode/server typecheck
pnpm typecheck
```

### Full server tests

```bash
pnpm --filter @opencode/server test
```

## Implementation Plan for Agents

请按阶段执行，不要一次性大爆炸式修改。

### Phase 1: Schema and contracts

1. 在 `packages/shared` 增加 `idle`、`AgentRunDto`、`AgentRunStatus`、`CancelRunResponse`、run events。
2. 在 `packages/db/schema` 增加 `agent-runs.lt.hcl`。
3. 给 messages/message_parts/tool_calls/approvals/session_events 增加 nullable `run_id`。
4. 更新 session status check，加入 `idle`。
5. 生成 migration，运行 `pnpm db:sync`。
6. 更新 ORM schema/relations，如 db:sync 未覆盖则手动同步。
7. 跑 typecheck。

### Phase 2: Repositories and services data plumbing

1. 新增 `agent-run-repository.ts`。
2. 更新 message/tool/approval/event repositories 支持 `runId`。
3. 更新 message/message part/tool state services 支持传递 `runId`。
4. 新增 `apps/server/src/services/agent/run-service.ts`。
5. 添加 repository/service tests。

### Phase 3: Runner and agent runtime signal plumbing

1. `SessionRunner` 改 Map + AbortController。
2. `Lifecycle` / `RunLoop` / `SessionProcessor` / `ToolExecutor` / `streamModelResponse` / tools 接收 `runId` 和 `AbortSignal`。
3. `streamText` 传 abort signal。
4. `run_command` 支持 abort kill。
5. 增加 cancelled result 类型。
6. agent tests 覆盖 abort before/during execution。

### Phase 4: Prompt/resume/cancel route integration

1. prompt 时创建 run，并把 user/assistant/tool/approval/event 写入同一个 runId。
2. approval resume 使用原 runId，不创建新 run。
3. 新增 cancel current run route/schema/handler。
4. cancel route 调 `runService.cancelCurrentRun`。
5. lifecycle 在 run completed/cancelled/failed/blocked/paused_for_approval 后更新 run status 和 session status。
6. SSE 事件列表加入 run events。
7. 更新 `resumeSession` 语义：只有 `session.status === 'waiting_approval'` 且 checkpoint/run/approval/tool/part 校验全部通过时返回 `canResume: true`；`idle`、`planning`、`executing`、`blocked`、`failed`、`completed`、`archived` 都返回 `canResume: false`。

### Phase 5: Frontend integration

1. `api.ts` 新增 cancel API。
2. `use-session-stream.ts` 监听 run events 和 message.cancelled。
3. UI 支持 `idle` 状态。
4. 在 executing/waiting_approval 显示 cancel run 按钮。
5. cancelled assistant message 展示为“本轮回复已取消”。

### Phase 6: Hardening

1. 重启恢复策略：server 启动时把历史 `running` runs 修复为 `failed` 或 `cancelled/interrupted`。第一版可作为后续 TODO。
2. 确保 cancel 幂等。
3. 确保 completed run 不会被 cancel 覆盖。
4. 补充 docs/AGENTS 说明 run/service 边界。

## Decided Questions

1. 第一版只允许 `planning` 和 `idle` session 提交 prompt，不允许 `completed` session 继续 prompt。
2. cancellation 下 `tool_calls.status` 统一为 `failed`，`approvals.status` 统一为 `rejected`，`ToolPart.state.reason` 统一为 `interrupted`。
3. `message_parts.run_id` 只作为数据库列，不写入 `MessagePart` JSON。
4. completed run 的 cancel 竞态统一返回 `cancelled: false`、`reason: 'no_active_run'`。
5. `SessionEventEnvelope` 顶层第一版不增加 `runId`，run 关系保存在 `session_events.run_id` 和 event payload 中。

## Open Questions

1. cancel reason 是否需要 enum？第一版可以 string，后续收敛为 enum。
2. server 重启后 running run 怎么处理？建议后续 Phase 6 明确修复策略。

## Acceptance Criteria

1. 每次用户 prompt 都创建一条 `agent_runs` 记录。
2. run 创建顺序为 agent_run(trigger null) -> user message(runId) -> 回填 triggerMessageId。
3. run 产物的 messages/message_parts/tool_calls/approvals/session_events 能通过 `run_id` 追踪。
4. run 正常结束后 `agent_runs.status = completed`，`sessions.status = idle`。
5. run 等待 approval 时 `agent_runs.status = waiting_approval`，`sessions.status = waiting_approval`。
6. approval resume 时原 run 从 `waiting_approval` 回到 `running`，不创建新 run。
7. `POST /api/sessions/:id/runs/current/cancel` 能取消 active run。
8. completed run 竞态 cancel 返回 `cancelled: false`、`reason: 'no_active_run'`。
9. 取消后 `agent_runs.status = cancelled`，`sessions.status = idle`。
10. 取消后 running assistant message 不再是 `running`。
11. 取消后 pending/running tool part 不再是 `pending/running`。
12. 取消后 pending/running/pending_approval tool call 统一为 `failed`。
13. 取消后 pending approval 不再是 `pending`，统一为 `rejected`。
14. `resumeSession` 对 idle session 返回 `canResume: false`。
15. 前端收到 `run.cancelled` / `session.updated` 后能刷新到 idle。
16. 用户取消 run 后再发送“继续”，会创建新 run，并能基于历史上下文继续。
