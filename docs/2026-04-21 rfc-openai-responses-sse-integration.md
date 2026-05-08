# RFC: OpenAI Responses + Session SSE 实施文档

Status: Accepted

Owner: OpenCode

Last Updated: 2026-04-21

## 1. 目标

这份文档不是泛泛的方案说明，而是给后续 agent 直接照着实施的执行文档。

本阶段只解决以下最小闭环：

1. 服务端接通真实 OpenAI 模型调用。
2. 服务端通过 SSE 向前端持续推送 `SessionEvent`。
3. `read_file` 工具可自动执行。
4. `write_file` / `run_command` 可进入审批并在审批后继续。
5. 会话状态、消息、事件、工具调用、审批全部落 SQLite。
6. 页面刷新或断线后可以从数据库重放事件并继续订阅。

## 2. 已确认决策

### 2.1 模型层

采用 `openai` 官方 Node SDK，核心接口使用 `Responses API`。

接受以下恢复方案：

1. 使用 OpenAI `previous_response_id` 作为 provider-level continuation anchor。
2. 审批暂停时，将 `previous_response_id` 写入 `sessions.last_checkpoint_json`。
3. 审批恢复时，优先使用 `previous_response_id` 继续，而不是每次都从本地完整历史重建输入。

### 2.2 SSE 层

采用现有 `hono/streaming` 的 `streamSSE`。

前端采用浏览器原生 `EventSource`，不额外引入 SSE 客户端库。

### 2.3 Provider 抽象

参考 `/home/daohaosisi/dev/mono-demo-253/apps/server/src/services/ai` 的抽象思路，但不复用它的 Cloudflare agent runtime。

可以直接借鉴的内容：

1. `provider.ts` 负责构造模型 client。
2. `models.ts` 负责模型配置和默认模型。
3. metering / provider 边界要与业务编排解耦。

不能照搬的内容：

1. Durable Object。
2. `AIChatAgent`。
3. Cloudflare `toUIMessageStreamResponse()`。
4. 基于 Cloudflare agent runtime 的消息协议。

### 2.4 v1 范围控制

v1 明确采用以下限制：

1. `parallel_tool_calls = false`。
2. 单 session 同时只允许一个 active agent run。
3. 本阶段不落真实 `plan` / `task` / `artifact` 业务流。
4. 本阶段不引入 WebSocket。
5. 本阶段不引入 Vercel AI SDK 作为核心 agent runtime。

## 3. 官方资料与已核对结论

### 3.1 OpenAI 官方 `openai-node`

已核对以下公开资料：

1. `README.md`
2. `examples/responses/stream.ts`
3. `examples/responses/streaming-tools.ts`
4. `src/resources/responses/responses.ts`
5. `helpers.md`

已确认的关键点：

1. `client.responses.create({ stream: true })` 支持 SSE 流。
2. `client.responses.stream(...)` 提供事件监听和 `finalResponse()`。
3. 存在 `response.output_text.delta` 事件，可直接映射为前端文本增量。
4. 存在 `response.function_call_arguments.delta` / `.done` 事件，可用于工具参数流式收集。
5. 存在 `previous_response_id`，官方说明用于 multi-turn conversation state。
6. 存在 `parallel_tool_calls` 开关。
7. Node 代理可通过 `fetchOptions.dispatcher = new ProxyAgent(...)` 配置。

### 3.2 Hono 官方 streaming 文档

已确认：

1. `streamSSE()` 可直接写 `event`、`id`、`data`。
2. stream 回调内部异常不会再走 Hono 全局 `onError`，因此需要在业务流内部显式捕获并发出失败事件。

### 3.3 MDN `EventSource`

已确认：

1. 浏览器原生支持命名事件监听。
2. 断线自动重连时浏览器会带上 `Last-Event-ID`。
3. `EventSource` 是单向通道，非常适合当前架构。
4. HTTP/1.1 下同域 SSE 连接数有限，因此前端必须只给当前打开 session 建一条连接。

## 4. 当前仓库现状

### 4.1 已有基础

1. `packages/orm/src/schema.ts` 已经存在 `messages`、`tool_calls`、`approvals`、`session_events`、`sessions` 表。
2. `packages/shared/src/events.ts` 已经定义了 `SessionEvent`。
3. `packages/agent-core/src/tool-registry.ts` 已经定义了三个工具的 JSON schema。
4. `apps/server/src/tools/*.ts` 已经有本地工具实现雏形。
5. `apps/server/src/routes/agent/agent.route.ts` 已经预留了 `POST /messages` 和 `GET /stream`。

### 4.2 当前缺口

1. `apps/server/src/agent/loop.ts` 仍然只是 `MockModelClient.complete()`。
2. `apps/server/src/routes/agent/agent.handler.ts` 的 SSE 仍是 demo 数据。
3. `apps/server/src/services/session-service.ts` 的消息存储仍然是内存 `Map`。
4. `apps/web/src/hooks/use-session-stream.ts` 仍是 stub。
5. `apps/web/src/lib/api.ts` 还没有提交消息 API。
6. `approvals.handler.ts` 还没有真实审批状态变更和恢复逻辑。
7. 当前共享事件没有 SSE envelope，无法稳定做 replay / resume。

### 4.3 已知仓库异常

`.env.example` 当前混入了错误的 patch 文本，已经不是干净的 env 示例文件。正式实施前应先修复该文件。

## 5. 非目标

本阶段不做以下内容：

1. 完整的 plan/task 编排引擎。
2. 真正的 `TaskBoard` 真实数据改造。
3. artifact 系统。
4. 多 provider 同时可切换运行。
5. WebSocket / Realtime API。
6. 分布式多进程协调。

## 6. 目标架构

```text
Composer POST /api/sessions/:sessionId/messages
  -> persist user message
  -> append session event
  -> schedule async agent run

Agent run
  -> openai.responses.stream(...)
  -> persist assistant/tool/approval state
  -> append session events
  -> publish live events to stream subscribers

GET /api/sessions/:sessionId/stream
  -> replay persisted session_events from SQLite
  -> subscribe live fan-out
  -> EventSource receives named SSE events
```

关键原则：

1. SQLite 是真源。
2. 内存只负责 live fan-out，不保存真状态。
3. SSE endpoint 同时负责历史重放和实时订阅。
4. Agent runtime 只编排模型、工具、审批，不直接承担持久化细节。

## 7. 依赖与环境变量

### 7.1 新增依赖

`apps/server/package.json` 预计至少新增：

1. `openai`
2. `undici`

说明：

1. `openai` 用于 `Responses API`。
2. `undici` 用于按 OpenAI 官方方式配置代理 `ProxyAgent`。

### 7.2 环境变量

服务端至少支持：

1. `OPENAI_API_KEY` 必填。
2. `OPENAI_MODEL` 可选，默认使用现有 `.env.example` 的值或 provider 内默认值。
3. `OPENAI_BASE_URL` 可选，预留给兼容网关或自定义转发。
4. `HTTPS_PROXY` / `HTTP_PROXY` / `https_proxy` / `http_proxy` 可选。

实现要求：

1. provider 初始化时自动读取上述 proxy 环境变量。
2. 如果命中 proxy，则构造 `new ProxyAgent(proxyUrl)` 并传给 `fetchOptions.dispatcher`。

## 8. 数据契约调整

### 8.1 新增 SSE envelope

在 `packages/shared/src/events.ts` 中新增：

```ts
export type SessionEventEnvelope = {
  sequenceNo: number;
  createdAt: string;
  event: SessionEvent;
};
```

原因：

1. `SessionEvent` 目前只有业务语义，没有 SSE replay 所需的序号。
2. SSE `id` 需要稳定映射为 `sequenceNo`。
3. 前端断线重连要靠 `Last-Event-ID`。

### 8.2 建议新增提交消息 contract

在 `packages/shared/src/contracts.ts` 或相邻位置新增：

```ts
export const submitSessionMessageInputSchema = z.object({
  content: z.string().trim().min(1)
});

export type SubmitSessionMessageInput = z.infer<
  typeof submitSessionMessageInputSchema
>;
```

返回值建议从“assistant message”改成“已接受的 user message”或最小 ack。

推荐返回：

```ts
export type SubmitSessionMessageResponse = {
  accepted: true;
  message: MessageDto;
};
```

原因：

1. assistant 输出应该完全从 SSE 来。
2. `POST /messages` 只负责提交和触发，不同步等待最终答案。

### 8.3 保持 `SessionEvent` 现有 union，但补齐使用语义

本阶段直接使用现有事件类型，不做大规模改名。

语义约定如下：

1. `message.created` 用于 user / assistant / tool message 创建。
2. `message.delta` 只用于 assistant 文本增量。
3. `message.completed` 只用于 assistant message 完成。
4. `tool.pending` 表示工具调用已生成，但需要审批。
5. `approval.created` 表示审批实体已落库。
6. `approval.resolved` 表示审批已作出决定。
7. `tool.running` / `tool.completed` / `tool.failed` 覆盖工具执行态。
8. `session.resumable` 在 checkpoint 更新后发出。
9. `session.updated` 在 session 状态或 `updatedAt` 变化后发出。

## 9. 数据库落地策略

### 9.1 本阶段真正接通的表

1. `messages`
2. `tool_calls`
3. `approvals`
4. `session_events`
5. `sessions`

### 9.2 建议新增 repository

在 `apps/server/src/repositories/` 新增：

1. `message-repository.ts`
2. `session-event-repository.ts`
3. `tool-call-repository.ts`
4. `approval-repository.ts`

repository 职责：

1. 只负责 DB 读写和 row -> DTO 映射。
2. 不负责模型调用、审批业务分支、SSE 推送。

### 9.3 `session_events` 作为 replay log

写入要求：

1. 每次追加事件时，为当前 session 分配严格递增的 `sequenceNo`。
2. `payloadJson` 保存完整 `SessionEventEnvelope.event`。
3. `type` 保存 `event.type`。
4. `createdAt` 与 envelope 的 `createdAt` 保持一致。

实现要求：

1. 追加事件必须走单个 SQLite transaction。
2. `sequenceNo` 分配与 insert 必须放在同一 transaction 内。

## 10. 服务端模块设计

### 10.1 新增 `apps/server/src/services/ai/`

建议文件：

1. `provider.ts`
2. `models.ts`
3. `index.ts`

要求：

1. `provider.ts` 返回 `OpenAI` client。
2. 支持 `OPENAI_BASE_URL`。
3. 支持 proxy 环境变量映射到 `undici.ProxyAgent`。
4. `models.ts` 保留 model registry 思想，但不要过度设计。

### 10.2 新增事件服务

建议新增：

1. `apps/server/src/services/session-event-service.ts`
2. `apps/server/src/services/session-stream-hub.ts`

职责划分：

1. `session-event-service`
   负责持久化 envelope，并在成功后调用 hub 发布 live event。
2. `session-stream-hub`
   只负责 `subscribe(sessionId)` / `publish(envelope)`。

### 10.3 扩展 `stream-service.ts`

当前 `serializeEvent()` 只有 `JSON.stringify`，需要扩展为真正的 SSE 编码辅助。

至少需要：

1. `toSseEventName(envelope)`
2. `toSseData(envelope)`
3. 可选 `writeEnvelope(streamWriter, envelope)` helper

### 10.4 新建真实 agent runtime

建议不要继续把全部逻辑塞在当前 `apps/server/src/agent/loop.ts` 的 20 行类里。

推荐拆成：

1. `apps/server/src/agent/runtime.ts`
2. `apps/server/src/agent/openai-runner.ts`
3. `apps/server/src/agent/tool-executor.ts`
4. `apps/server/src/agent/checkpoint.ts`

允许保留 `loop.ts` 作为 facade，但不要把所有逻辑堆在一个文件。

## 11. Agent runtime 运行规则

### 11.1 单 session 单 active run

必须实现 per-session in-memory lock。

v1 规则：

1. 同一 session 在 `executing` 且 lock 占用时，不接受第二个并发 run。
2. 新的 `POST /messages` 若命中 active run，返回 `409`。
3. 前端应依据 `session.status` 或本地 `active run` 状态禁用重复提交，SSE 连接状态只用于展示。

### 11.2 session 状态迁移

本阶段统一采用以下状态语义：

1. session 创建后仍为 `planning`。
2. 第一次真正提交消息或审批恢复时切到 `executing`。
3. 生成审批时切到 `waiting_approval`。
4. 模型或工具出现未恢复异常时切到 `failed`。
5. 本阶段不自动把 session 标记为 `completed`。

### 11.3 assistant message 策略

assistant message 采用懒创建策略，避免纯工具轮次落空 message。

建议流程：

1. 只有在收到第一个 `response.output_text.delta` 时才创建 assistant message row。
2. 创建后立即发 `message.created`。
3. 每个 `response.output_text.delta` 追加到内存缓冲，并发 `message.delta`。
4. 流结束时，只有在本轮确实创建过 assistant message 的前提下，才将最终文本写回 `messages.contentJson`，并发 `message.completed`。
5. 如果本轮只有 tool call、没有任何文本输出，则不创建 assistant message。

### 11.4 tool message 策略

工具执行完成后，为 UI 和后续审计创建独立 `role: 'tool'` 的 message row。

内容可沿用现有 `MessagePart`：

```ts
{ type: 'tool_result', toolName: 'read_file', content: result }
```

## 12. OpenAI Responses 事件到本地事件的映射

### 12.1 文本流

| OpenAI 事件                         | 本地动作                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------- |
| 第一个 `response.output_text.delta` | 懒创建 assistant message，先发 `message.created`，再发本次 `message.delta` |
| 后续 `response.output_text.delta`   | 发 `message.delta`                                                         |
| stream finish                       | 仅当本轮已创建 assistant message 时，发 `message.completed`                |

### 12.2 工具参数流

| OpenAI 事件                              | 本地动作                            |
| ---------------------------------------- | ----------------------------------- |
| `response.function_call_arguments.delta` | 仅在内存聚合，不立即落库            |
| `response.function_call_arguments.done`  | 解析完整参数，创建 `tool_calls` row |

### 12.3 审批工具

`write_file` 和 `run_command` 的行为：

1. 创建 `tool_calls` row，状态为 `pending_approval`。
2. 创建 `approvals` row，状态为 `pending`。
3. session 状态切到 `waiting_approval`。
4. 写入 checkpoint，其中必须包含：
   - `approvalId`
   - `toolCallId`
   - `previousResponseId`
   - OpenAI `call_id` 或等价的 function call anchor
   - tool name
   - parsed input
5. 依次发出：
   - `tool.pending`
   - `approval.created`
   - `session.resumable`
   - `session.updated`
6. 立即结束当前 run，等待审批 API 恢复。

### 12.4 自动工具

`read_file` 的行为：

1. 创建 `tool_calls` row，状态为 `running`。
2. 发 `tool.running`。
3. 执行工具。
4. 成功时：
   - 更新 `tool_calls.status = completed`
   - 创建 tool message
   - 发 `tool.completed`
5. 失败时：
   - 更新 `tool_calls.status = failed`
   - 发 `tool.failed`
6. 生成 `function_call_output` 输入，继续下一次 `responses.stream(...)`。

## 13. Checkpoint 设计

`sessions.last_checkpoint_json` 在本阶段至少支持：

```json
{
  "kind": "waiting_approval",
  "approvalId": "approval_xxx",
  "toolCallId": "tool_xxx",
  "updatedAt": "2026-04-21T00:00:00.000Z",
  "provider": {
    "openai": {
      "previousResponseId": "resp_xxx",
      "callId": "call_xxx"
    }
  }
}
```

约束：

1. checkpoint 中必须显式保留 provider 名称，避免以后扩 provider 时语义冲突。
2. `previousResponseId` 是恢复主锚点。
3. 不要把大块 message 历史塞进 checkpoint。

### 13.1 扩展 `SessionCheckpoint` shared type

当前 `packages/shared/src/dto.ts` 中已经有 `SessionCheckpoint`，实现阶段必须同步扩展，而不是继续让文档和 shared type 漂移。

建议至少扩展为：

```ts
export type SessionCheckpoint = {
  approvalId?: string;
  kind:
    | 'session_created'
    | 'planning'
    | 'waiting_plan_confirmation'
    | 'executing_task'
    | 'waiting_approval'
    | 'failed'
    | 'completed';
  note?: string;
  planId?: string;
  provider?: {
    openai?: {
      callId?: string;
      previousResponseId?: string;
    };
  };
  taskId?: string;
  toolCallId?: string;
  updatedAt: string;
};
```

要求：

1. `toolCallId` 必须进入 shared type。
2. `provider.openai.previousResponseId` 必须进入 shared type。
3. 如果实现时决定改名或细化字段，必须同步修改 RFC 和 shared type，而不是只改其中一边。

## 14. Agent runtime 伪代码

```ts
async function runTurn(sessionId: string, input: ResponseInputItem[]) {
  acquireSessionLock(sessionId);

  let previousResponseId =
    checkpoint?.provider?.openai?.previousResponseId ?? null;
  let nextInput = input;

  while (true) {
    markSessionExecuting(sessionId);

    const stream = client.responses.stream({
      model,
      input: nextInput,
      previous_response_id: previousResponseId,
      tools,
      parallel_tool_calls: false
    });

    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        ensureAssistantMessageCreatedOnFirstTextDelta(sessionId);
      }

      handleOpenAiEvent(event);
    }

    const finalResponse = await stream.finalResponse();
    previousResponseId = finalResponse.id;

    if (hasPendingApproval()) {
      persistCheckpoint(previousResponseId, pendingApproval);
      return;
    }

    if (hasAutoToolOutputs()) {
      nextInput = buildFunctionCallOutputs();
      continue;
    }

    clearCheckpointToExecuting(previousResponseId);
    return;
  }
}
```

## 15. 审批 API 行为

当前代码已有：

1. `POST /api/approvals/:approvalId/approve`
2. `POST /api/approvals/:approvalId/reject`

本阶段为最小改动，继续沿用这两个路由，不改成统一 `decision` 端点。

### 15.1 approve

处理顺序：

1. 更新 approval 状态为 `approved`。
2. 更新 tool_call 状态为 `approved`。
3. 发 `approval.resolved`。
4. 立即执行真实工具。
5. 根据执行结果发 `tool.running` / `tool.completed` 或 `tool.failed`。
6. 组装 `function_call_output`，基于 checkpoint 的 `previousResponseId` 恢复 OpenAI run。

### 15.2 reject

处理顺序：

1. 更新 approval 状态为 `rejected`。
2. 更新 tool_call 状态为 `rejected`。
3. 发 `approval.resolved`。
4. 发 `tool.failed`，错误文本固定为 `Approval rejected by user`。
5. 向 OpenAI 返回一个 synthetic `function_call_output`，内容表示该工具被用户拒绝执行。
6. 基于同一 `previousResponseId` 继续模型，让模型有机会解释、降级或提出替代方案。

说明：

1. 这样不会卡死在 `waiting_approval`。
2. 这样也不会真的执行被拒绝的工具。

## 16. SSE endpoint 实施要求

### 16.1 路由行为

`GET /api/sessions/:sessionId/stream` 必须同时承担：

1. 历史 replay。
2. live subscribe。
3. 自动重连后的增量追赶。

### 16.2 replay 语义

规则：

1. 如果浏览器自动带了 `Last-Event-ID`，则只 replay `sequenceNo > lastEventId` 的事件。
2. 如果没有 `Last-Event-ID`，则 replay 该 session 全部历史事件。
3. replay 完成后再持续输出 live 事件。

### 16.3 race-free 订阅顺序

为了避免“查询 replay 和订阅 live 之间漏事件”，SSE handler 必须按下面的顺序实现：

1. 先创建当前连接的内存 subscriber queue。
2. 再查询并写出数据库中的 replay 事件。
3. 记录 replay 后的最高 `sequenceNo`。
4. flush queue 中大于该 `sequenceNo` 的 live 事件。
5. 进入持续 live 模式。

### 16.4 keepalive

建议每 15 到 30 秒发一次轻量 keepalive event 或 comment，避免本地代理和浏览器闲置断开。

## 17. 前端实施要求

### 17.1 `apps/web/src/lib/api.ts`

新增：

1. `submitSessionMessage(sessionId, input)`
2. 继续保留 `getSession()`、`resumeSession()`、`listMessages()`

不需要在 `api.ts` 里封装 EventSource，直接在 hook 中创建。

### 17.2 `apps/web/src/hooks/use-session-stream.ts`

重写为真实 hook，最低要求：

1. 入参为 `sessionId?: string`。
2. 只在有 `sessionId` 时建立连接。
3. 监听命名事件，如 `message.created`、`message.delta` 等。
4. 解析 `SessionEventEnvelope`。
5. 将事件同步到 React Query cache 或局部 state。
6. 暴露 `status: 'connecting' | 'connected' | 'disconnected' | 'error'`。

### 17.3 历史数据来源

前端初次打开 session 页面时：

1. `GET /api/sessions/:id/messages` 作为消息历史真源。
2. `GET /api/sessions/:id/stream` 在无 `Last-Event-ID` 时 replay 全部事件历史，但这份 replay 不用于重建消息列表。

说明：

1. 本阶段不额外新增 `GET /api/sessions/:id/events`。
2. 时间线可以直接消费 SSE replay + live 数据。
3. 消息列表初始化只来自 `GET /messages`。
4. 首次建连时 replay 出来的 `message.created` / `message.delta` / `message.completed` 不能再次注入消息列表，避免与 `GET /messages` 重复。
5. 建连完成后的 live `message.*` 事件仍然用于实时更新当前页面上的消息列表。

### 17.4 `Composer`

`apps/web/src/features/chat/composer.tsx` 需要从静态按钮改为真实表单提交。

最低要求：

1. `onSubmit` 调 `submitSessionMessage()`。
2. 提交成功后清空输入。
3. 依据 `session.status` 或本地 `active run` 状态禁用按钮，而不是依据 SSE 连接状态禁用。

## 18. 文件级实施清单

### 18.1 新增文件

建议新增：

1. `apps/server/src/services/ai/provider.ts`
2. `apps/server/src/services/ai/models.ts`
3. `apps/server/src/services/ai/index.ts`
4. `apps/server/src/repositories/message-repository.ts`
5. `apps/server/src/repositories/session-event-repository.ts`
6. `apps/server/src/repositories/tool-call-repository.ts`
7. `apps/server/src/repositories/approval-repository.ts`
8. `apps/server/src/services/session-event-service.ts`
9. `apps/server/src/services/session-stream-hub.ts`
10. `apps/server/src/agent/runtime.ts`
11. `apps/server/src/agent/checkpoint.ts`
12. `apps/server/src/agent/tool-executor.ts`

### 18.2 必改文件

1. `apps/server/package.json`
2. `.env.example`
3. `packages/shared/src/contracts.ts`
4. `packages/shared/src/dto.ts`
5. `packages/shared/src/events.ts`
6. `packages/shared/src/index.ts`
7. `apps/server/src/services/session-service.ts`
8. `apps/server/src/agent/loop.ts`
9. `apps/server/src/agent/model-client.ts`
10. `apps/server/src/services/stream-service.ts`
11. `apps/server/src/routes/agent/agent.handler.ts`
12. `apps/server/src/routes/approvals/approvals.handler.ts`
13. `apps/server/src/routes/sessions/sessions.handler.ts`
14. `apps/web/src/lib/api.ts`
15. `apps/web/src/hooks/use-session-stream.ts`
16. `apps/web/src/features/chat/composer.tsx`
17. `apps/web/src/router.tsx`

## 19. 推荐实施顺序

必须按以下顺序推进，避免前后端同时漂移：

1. 修复 `.env.example` 污染内容。
2. 增加 server 依赖和 provider 层。
3. 增加 repository 与消息 / 事件持久化。
4. 打通 SSE replay + live fan-out。
5. 把 `POST /messages` 改成持久化 user message + 异步触发 run。
6. 只接通纯文本 assistant 流。
7. 接 `read_file` 自动工具。
8. 接审批工具和 checkpoint 恢复。
9. 接前端 `EventSource` 和 composer。
10. 最后再把 mock timeline 局部替换成真实事件。

不要一开始就同时改审批、前端、工具 loop 和 replay，否则排错成本会明显升高。

## 20. 完成标准

实现完成至少满足以下 smoke path：

1. 用户在 `Composer` 提交一条消息。
2. `POST /messages` 立即返回 `202` 和已持久化 user message。
3. 前端通过 SSE 收到 assistant 文本增量。
4. 页面刷新后，历史 messages 仍存在，SSE 仍可正常重连。
5. 模型触发 `read_file` 时，工具自动执行，assistant 能继续输出。
6. 模型触发 `write_file` 或 `run_command` 时，前端出现审批卡。
7. 审批通过后，工具执行并继续模型输出。
8. 审批拒绝后，不会卡死，assistant 会继续给出解释或替代方案。

## 21. 验证命令

实现过程中和完成后至少执行：

```bash
pnpm typecheck
pnpm lint
pnpm build
```

本仓库当前没有正式测试脚本，因此本阶段以类型、lint、build 和手工 smoke 测试为准。

## 22. 后续阶段预留

当前设计已经为后续阶段预留了以下扩展点：

1. provider 抽象可切换其他兼容 OpenAI 的网关。
2. `SessionEventEnvelope` 可扩展为更通用 replay 协议。
3. checkpoint 已预留 `provider.openai` 结构，后续可新增其他 provider 命名空间。
4. repository 分层可继续接 `plans` / `tasks` / `artifacts`。
5. `session_events` 既能服务时间线，也能服务未来审计和恢复分析。

## 23. 对后续 agent 的明确执行提示

后续 agent 在开始改代码前，必须先确认以下事实：

1. 本 RFC 已接受 `previous_response_id` 方案，不要回退到“每步完整重建上下文”路线。
2. 本 RFC 明确不复用 Cloudflare `AIChatAgent` 体系。
3. 本 RFC 明确要求 SQLite 为真源，内存只做 live fan-out。
4. 本 RFC 明确要求 `parallel_tool_calls = false`。
5. 本 RFC 明确要求审批通过和拒绝都能结束 `waiting_approval`。
6. 本 RFC 明确要求 SSE endpoint 同时承担 replay 和 live subscribe。

如果后续实现需要偏离这六条，必须先更新本 RFC，再改代码。
