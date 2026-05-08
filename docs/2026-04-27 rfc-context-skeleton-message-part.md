# RFC: AI SDK 上下文骨架与 Message + Part 架构

Status: Proposed

Owner: OpenCode

Last Updated: 2026-04-27

## 1. 目标

本 RFC 定义下一阶段上下文骨架重构方案。方案明确采用 opencode 风格的 `Message + Part` 架构，并进行破坏性历史重构：旧 session 历史不做兼容迁移，旧 `role='tool'` message、旧 `messages.content_json` transcript、旧 `previous_response_id` checkpoint 都不再作为恢复依据。

核心目标：

1. `MessageInfo + MessagePart[]` 成为唯一应用层上下文真源。
2. 每轮模型调用都从 SQLite transcript 全量重建上下文。
3. 弃用 `openai` npm package 和 OpenAI Responses native runtime，改用 AI SDK 作为 provider/runtime 边界。
4. 明确弃用 OpenAI Responses `previous_response_id`，不再使用 provider-side conversation state。
5. 删除当前调试用途的 `statelessMode`，不再保留两套上下文模式。
6. 第一阶段原生支持 tool call/result，使用 `ToolPart` 状态机保存 call 与 result。
7. 当前不实现 compact，但必须为后续 compact、tool prune、短期记忆预留字段和函数边界。
8. 显式解决 system context、tool execution、final response reconciliation 三个边界，避免它们散落在 adapter 或 processor 中。

## 2. 设计判断

### 2.1 为什么弃用 `openai` 库和 `previous_response_id`

`previous_response_id` 让 OpenAI provider 维护 conversation state。它能减少每轮重传历史，但会带来几个根本问题：

1. 应用层无法精确审计模型实际看到的上下文。
2. 无法可靠裁剪某个旧 tool result。
3. compact 后 provider 侧仍可能保留未 compact 的旧上下文。
4. approval resume 依赖 provider response chain，恢复边界不清晰。
5. 跨 provider 或切换模型时上下文不能直接复用。

直接使用 `openai` 库还会把 runtime 绑到 OpenAI Responses 的 native shape 上：`ResponseInputItem[]`、`function_call_output`、provider item id、Responses SSE event 都会渗透到应用层。后续如果要支持 Anthropic、Google、本地模型或 opencode 风格 provider transform，就需要重写 runtime。

本 RFC 选择把 conversation state 和上下文 replay 全部转移到应用层，并把 provider 调用统一放到 AI SDK：

```text
SQLite Message + Part transcript
  -> ContextBuilder
  -> AiSdkRequestAdapter
  -> AI SDK streamText({ model, system, messages, tools })
```

OpenAI 仍可作为模型 provider 使用，但只通过 `@ai-sdk/openai` 进入系统。应用代码不直接依赖 `openai` package，不直接构造 OpenAI Responses request，也不使用 `previous_response_id`。

### 2.2 为什么采用 AI SDK 作为 provider 边界

AI SDK 提供的价值不是替代我们的 transcript，而是把 provider 差异压到一个可替换边界里：

| 能力                        | 用途                                                                         |
| --------------------------- | ---------------------------------------------------------------------------- |
| `ModelMessage[]`            | 作为模型调用前的 provider-neutral message shape。                            |
| `Tool` / `ToolSet`          | 作为工具 schema 和 provider transform 的统一入口。                           |
| `streamText` / `fullStream` | 统一 text、reasoning、tool-call、finish、usage 等流事件。                    |
| provider packages           | 例如 `@ai-sdk/openai`，让 OpenAI 变成 provider adapter，而不是核心 runtime。 |
| provider options            | 将 provider-specific 配置限制在 adapter/model client 层。                    |

关键边界：

1. SQLite 中仍保存自定义 `MessageInfo + MessagePart[]`，不保存 AI SDK native message 作为真源。
2. `ContextBuilder` 输出 `BuiltContext`，不输出 provider-native request。
3. `AiSdkRequestAdapter` 把 `BuiltContext` 投影为 `system + ModelMessage[] + ToolSet`。
4. `SessionProcessor` 消费 AI SDK stream event，并写回 `MessagePart`。
5. `ToolExecutor` 负责本地工具副作用；AI SDK tool `execute` 第一阶段不直接执行工具。

### 2.3 为什么破坏性重构旧历史

旧历史缺少两个关键信息：

1. 旧 `tool_result` message 没有可靠的 model tool call pairing id。
2. 旧 assistant text/tool call 没有稳定的 part-level 结构，无法安全投影为 AI SDK `ModelMessage[]`。

弃用 `previous_response_id` 后，adapter 必须能从 transcript 重建 assistant tool-call 和 tool-result pairing。旧历史无法可靠满足这一点。

因此本 RFC 明确：

1. 不做旧 session 的精确上下文迁移。
2. 不实现旧 `role='tool'` message 到 `ToolPart` 的兼容转换。
3. migration 可以删除所有旧 session runtime 数据，或要求开发环境重建 DB。
4. 旧 session 如果仍保留在 DB 中，必须标记为 incompatible/archived，不允许继续 agent run。

## 3. 非目标

本阶段不做：

1. 不实现 compact summary。
2. 不实现长期记忆、RAG、embedding/vector index。
3. 不实现 MCP。
4. 不扩展完整工具集。
5. 不保留 `previous_response_id` fallback。
6. 不保留 `statelessMode`。
7. 不兼容旧 session 精确续跑。
8. 不要求前端立刻消费 part-level SSE。
9. 不让 AI SDK `Tool.execute` 成为上下文真源或 approval 边界。
10. 不直接使用 `openai` package；OpenAI provider 只允许通过 AI SDK provider package 接入。

## 4. 目标链路

### 4.1 Prompt run

```text
Route
  -> SessionPromptService.prompt(PromptInput)
  -> PromptNormalizer.createUserMessage(input)
  -> create user MessageInfo
  -> append normalized user Parts
  -> SessionRunner.ensureRunning(sessionId)
  -> RunLoop.run(sessionId)
  -> load last user / session runtime state
  -> ContextBuilder.build(sessionId)
       -> load MessageWithParts[]
       -> reject incompatible legacy sessions
       -> filterCompacted(...)
       -> insertReminders(...)
       -> project visible parts
       -> repair dangling tools
       -> build system blocks
       -> estimate size
  -> ToolRegistry.resolveTools({ session, agent, model, lastUser, context })
  -> AiSdkRequestAdapter.toRequest(context, resolvedTools)
       -> system string
       -> ModelMessage[]
       -> ToolSet
       -> toolPolicies
       -> provider options
  -> ContextSizeGuard.assertFits({ context, resolvedTools, request })
  -> SessionProcessor.processTurn(request)
       -> AI SDK fullStream
       -> create/update assistant MessageInfo
       -> append/update assistant TextPart/ReasoningPart/ToolPart
       -> use request.toolPolicies for approval decisions
       -> reconcile finish reason / usage / provider metadata
       -> return completed | tool_calls | paused_for_approval | failed
  -> ToolExecutor.executePendingToolParts(...)
       -> update ToolPart running/completed/error
       -> sync tool_calls/approvals
  -> RunLoop decides stop / pause / continue
  -> next loop rebuilds full context from DB
```

### 4.2 Tool continuation

旧链路：

```text
previous_response_id + function_call_output[]
```

新链路：

```text
ToolPart completed/error
  -> ContextBuilder sees ToolPart
  -> AiSdkRequestAdapter reconstructs assistant tool-call + tool-result ModelMessage parts
  -> AI SDK request without provider conversation id
```

### 4.3 Approval resume

```text
resolveApproval(decision)
  -> load checkpoint(messageId, partId, modelToolCallId, toolCallId)
  -> load pending ToolPart
  -> if rejected: update ToolPart error
  -> if approved: execute tool and update ToolPart completed/error
  -> RunLoop.run(sessionId)
  -> rebuild full context from DB
  -> call AI SDK without provider conversation id
```

### 4.4 与 opencode 差距的处理

本 RFC 在主链路中显式放入以下边界：

| 差距                                 | 本 RFC 处理                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| system context 隐含在 adapter        | `SystemContextBuilder` 生成 `BuiltContext.system[]`，adapter 只负责映射为 AI SDK `system`。             |
| processor 和 tool execution 混合     | `SessionProcessor` 只消费 AI SDK stream 并持久化 parts，`ToolExecutor` 才执行本地工具。                 |
| final response reconciliation 不清楚 | `SessionProcessor` 在 stream end 统一保存 finish reason、usage、model tool call id、provider metadata。 |

## 5. 数据模型

### 5.1 MessageInfo

`MessageInfo` 保存消息元信息，不保存正文和 tool result。

```ts
export type MessageRole = 'user' | 'assistant';

export type MessageStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type MessageInfo = {
  id: string;
  sessionId: string;
  role: MessageRole;
  createdAt: string;
  updatedAt: string;
  parentMessageId?: string;
  agentName?: string;
  model?: {
    providerId: string;
    modelId: string;
  };
  status: MessageStatus;
  finishReason?: string;
  errorText?: string;
  summary?: boolean;
  compactedByMessageId?: string;
  modelResponseId?: string;
  providerMetadata?: Record<string, unknown>;
  tokenUsage?: {
    input: number;
    output: number;
    reasoning?: number;
    total?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  runtime?: MessageRuntimeMetadata;
};

export type MessageRuntimeMetadata = {
  userSystem?: string;
  toolOverrides?: Record<string, boolean>;
  format?:
    | { type: 'text' }
    | { type: 'json_schema'; schema: Record<string, unknown> };
  variant?: string;
};
```

字段规则：

| 字段               | 是否进入模型 | 说明                                                                                                   |
| ------------------ | ------------ | ------------------------------------------------------------------------------------------------------ |
| `role`             | 间接         | 决定投影为 user 或 assistant。                                                                         |
| `modelResponseId`  | 否           | AI SDK/provider 如果暴露 response id，则只用于 debug/audit，不参与续接。                               |
| `providerMetadata` | 否           | provider-specific metadata，只用于 debug/audit。                                                       |
| `summary`          | 间接         | 后续 compact summary 的边界标记。                                                                      |
| `tokenUsage`       | 否           | budget/compact/debug。                                                                                 |
| `runtime`          | 间接         | 保存 user message 级 system/tools/format/variant，供 system context、tool resolution 和 adapter 使用。 |

AI SDK replay 不要求保存 OpenAI Responses `providerOutputItemId`。assistant 历史通过 `role + parts` 投影为 `ModelMessage`。

### 5.2 PartBase

```ts
export type PartBase = {
  id: string;
  sessionId: string;
  messageId: string;
  type: string;
  order: number;
  createdAt: string;
  updatedAt: string;
};
```

`order` 是 message 内 part 的稳定排序依据。不得只依赖 JSON 数组顺序。

### 5.3 TextPart

```ts
export type TextPart = PartBase & {
  type: 'text';
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  metadata?: Record<string, unknown>;
};
```

进入模型规则：

1. `ignored === true` 不进入。
2. user text 投影为 AI SDK user text content。
3. assistant text 投影为 AI SDK assistant text content。
4. `metadata` 不进入模型。

### 5.4 FilePart 与 FileAttachment

顶层文件 part：

```ts
export type FilePart = PartBase & {
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
  source?: {
    kind: 'upload' | 'resource';
    path?: string;
  };
};
```

tool result 附件不是 `FilePart`，避免嵌套 part 要求 `PartBase` 字段：

```ts
export type FileAttachment = {
  mime: string;
  filename?: string;
  url: string;
};
```

第一阶段建议只完整支持 text file -> `TextPart`。image/pdf/file adapter 可先保留 schema，并在 context guard 中限制大小。

### 5.5 ReasoningPart

```ts
export type ReasoningPart = PartBase & {
  type: 'reasoning';
  text: string;
  metadata?: Record<string, unknown>;
};
```

第一阶段持久化但不进入模型。后续如果 provider 和 AI SDK 都支持 reasoning replay，再通过 adapter 显式开启。

### 5.6 ToolPart

`ToolPart` 同时表达 model tool call 和本地 tool result。

```ts
export type ToolPart = PartBase & {
  type: 'tool';
  toolName: string;
  toolCallId: string;
  modelToolCallId: string;
  state: ToolState;
  providerMetadata?: Record<string, unknown>;
};
```

字段边界：

| 字段               | 含义                                                                   |
| ------------------ | ---------------------------------------------------------------------- |
| `toolCallId`       | 内部 `tool_calls.id`，用于 DB/UI/approval。                            |
| `modelToolCallId`  | AI SDK `toolCallId`，用于 assistant tool-call 与 tool-result pairing。 |
| `toolName`         | 工具名。                                                               |
| `providerMetadata` | AI SDK/provider event metadata，不直接进入模型。                       |

`toolCallId` 和 `modelToolCallId` 严禁混用。`modelToolCallId` 是模型上下文 pairing id，`toolCallId` 是应用内部记录 id。

```ts
export type ToolState =
  | {
      status: 'pending';
      input: Record<string, unknown>;
      rawInput?: string;
    }
  | {
      status: 'running';
      input: Record<string, unknown>;
      title?: string;
      metadata?: Record<string, unknown>;
      startedAt: string;
    }
  | {
      status: 'completed';
      input: Record<string, unknown>;
      outputText: string;
      payload?: Record<string, unknown>;
      title?: string;
      metadata?: Record<string, unknown>;
      attachments?: FileAttachment[];
      startedAt: string;
      completedAt: string;
      compactedAt?: string;
    }
  | {
      status: 'error';
      input: Record<string, unknown>;
      errorText: string;
      reason?: 'execution_denied' | 'tool_error' | 'interrupted';
      payload?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      startedAt?: string;
      completedAt: string;
    };
```

模型可见字段：

| 状态        | 可见内容                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `completed` | `toolName`、`modelToolCallId`、`input`、`outputText`、可选 attachments。 |
| `error`     | `toolName`、`modelToolCallId`、`input`、`errorText`、`reason`。          |

不可见字段：`title`、`metadata`、`payload`、timestamps、internal `toolCallId`、`providerMetadata`。

### 5.7 PatchPart

```ts
export type PatchPart = PartBase & {
  type: 'patch';
  files: Array<{
    path: string;
    change: 'create' | 'delete' | 'update';
  }>;
  diffArtifactId?: string;
};
```

第一阶段不进入模型。

### 5.8 CompactionPart

```ts
export type CompactionPart = PartBase & {
  type: 'compaction';
  auto: boolean;
  reason: 'manual' | 'overflow' | 'budget';
  targetMessageId?: string;
};
```

第一阶段仅预留。`ContextBuilder.filterCompacted()` 当前 no-op。

## 6. PromptInput 与标准化层

Route 不应直接创建 `TextPart/FilePart`。所有用户输入必须先进入 `PromptInput`，再由 `PromptNormalizer` 统一转换为 `MessageInfo + MessagePart[]`。

### 6.1 PromptInput

```ts
export type PromptInput = {
  sessionId: string;
  messageId?: string;
  agentName?: string;
  model?: {
    providerId: string;
    modelId: string;
  };
  variant?: string;
  system?: string;
  tools?: Record<string, boolean>;
  format?:
    | { type: 'text' }
    | { type: 'json_schema'; schema: Record<string, unknown> };
  parts: PromptPartInput[];
};

export type PromptPartInput =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; filename?: string; url: string }
  | { type: 'agent'; name: string }
  | { type: 'subtask'; prompt: string; description: string; agentName: string };
```

第一阶段只必须支持 `text` 和基础 `file`。`agent/subtask` 可先保留 schema，不进入 runtime。

### 6.2 PromptNormalizer

```ts
export type NormalizedPrompt = {
  message: MessageInfo;
  parts: MessagePart[];
  runtime: {
    agentName: string;
    model: { providerId: string; modelId: string };
    variant?: string;
    toolOverrides?: Record<string, boolean>;
    format: PromptInput['format'];
    userSystem?: string;
  };
};
```

职责：

1. 生成或校验 `messageId`。
2. 解析默认 agent 和 model。
3. 把 user text 转成 `TextPart`。
4. 把 text/plain file 转成 `TextPart` 或后续 read-like synthetic text。
5. 把 image/pdf 等保留为 `FilePart`，但受 size guard 控制。
6. 保存 user message 级别的 `system/tools/format` runtime metadata，供后续 `ContextBuilder` 和 `ToolRegistry` 使用。
7. 不在 route 中散落 file/system/tool override 逻辑。

标准化规则：

| Input                     | Normalized output                       | Phase 1 行为                                                  |
| ------------------------- | --------------------------------------- | ------------------------------------------------------------- |
| `parts[].type='text'`     | `TextPart`                              | 必须支持，按输入顺序追加。                                    |
| `text/plain` file         | `TextPart.synthetic=true` 或 `FilePart` | 优先转成 model-visible text；超限由 size guard 拦截。         |
| `directory` file/resource | `TextPart.synthetic=true`               | 可先 no-op，但入口必须在 normalizer。                         |
| image/pdf/media file      | `FilePart`                              | 第一阶段可持久化但默认不投影，避免 route 判断 provider 能力。 |
| `system`                  | `MessageInfo.runtime.userSystem`        | 不生成普通 text part，避免 system 混入 user content。         |
| `tools`                   | `MessageInfo.runtime.toolOverrides`     | 只影响本轮及其后续 run loop 的 tool resolution。              |
| `format`                  | `MessageInfo.runtime.format`            | 交给 system context/adapter 注入 structured output 约束。     |
| `variant`                 | `MessageInfo.runtime.variant`           | 用于 provider/model 变体选择，不进入模型文本。                |

`NormalizedPrompt.runtime` 是服务层写库前的返回值，持久化后以 `MessageInfo.runtime` 为准。`Route` 只负责把 HTTP body 转成 `PromptInput`，不得直接创建 `MessageInfo`、`TextPart`、`FilePart` 或解析 tool override。

第一阶段落地建议：

```text
SessionPromptService.prompt(input)
  -> PromptNormalizer.createUserMessage(input)
  -> messageRepository.create(message)
  -> partRepository.appendMany(parts)
  -> SessionRunner.ensureRunning(sessionId)
```

## 7. 数据库重构

### 7.1 破坏性迁移策略

本 RFC 允许破坏旧 runtime 历史。

迁移必须执行以下策略之一：

1. 开发环境直接重建数据库。
2. 或删除所有 session runtime 相关数据：`sessions`、`messages`、`tool_calls`、`approvals`、`session_events`、`artifacts`、`plans`、`tasks`。
3. 如果保留 `workspaces`，必须把所有旧 sessions 级联删除。

禁止事项：

1. 禁止把旧 `role='tool'` message 迁移为可继续运行的 ToolPart。
2. 禁止使用旧 `previous_response_id` checkpoint 恢复 run。
3. 禁止旧 session 继续 prompt run。

### 7.2 messages 表

现有 `messages` 表需要从 content carrier 改为 message info carrier。

推荐目标字段：

```text
id
session_id
role
kind
parent_message_id
agent_name
model_provider_id
model_id
status
finish_reason
error_text
summary
compacted_by_message_id
model_response_id       -- optional debug/audit, not continuation state
provider_metadata_json  -- optional debug/audit
token_usage_json
runtime_json            -- user system/tools/format/variant
created_at
updated_at
content_json            -- 兼容 DTO snapshot，可为空数组
```

`role='tool'` 不再新增。AI SDK tool result 不存为独立 `role='tool'` message，而是存入 assistant `ToolPart`，在 adapter 阶段投影为 AI SDK tool-result message/part。

### 7.3 message_parts 表

```sql
CREATE TABLE message_parts (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_message_parts_message_order
  ON message_parts(message_id, order_index, id);

CREATE INDEX idx_message_parts_session_created
  ON message_parts(session_id, created_at, id);
```

### 7.4 tool_calls 表

`tool_calls` 继续存在，但不是 context truth。

建议补充字段：

```text
message_part_id
model_tool_call_id
provider_metadata_json
```

规则：

1. `message_parts.data_json` 中的 `ToolPart` 是 context truth。
2. `tool_calls` 是 approval/UI 查询索引。
3. `ToolPart.toolCallId === tool_calls.id`。
4. `ToolPart.modelToolCallId === tool_calls.model_tool_call_id`。
5. 同一 service/事务内更新 ToolPart 和 tool_calls。

## 8. Shared DTO

内部 schema 不直接等于 DTO。DTO 只暴露前端需要的信息。

```ts
export type ToolPartDtoState =
  | {
      status: 'pending' | 'running';
      input: Record<string, unknown>;
      title?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      status: 'completed';
      input: Record<string, unknown>;
      outputText: string;
      title?: string;
      metadata?: Record<string, unknown>;
      attachments?: FileAttachment[];
    }
  | {
      status: 'error';
      input: Record<string, unknown>;
      errorText: string;
      metadata?: Record<string, unknown>;
    };

export type MessagePartDto =
  | { id: string; type: 'text'; text: string; synthetic?: boolean }
  | { id: string; type: 'reasoning'; text: string }
  | { id: string; type: 'file'; mime: string; filename?: string; url: string }
  | {
      id: string;
      type: 'tool';
      toolName: string;
      toolCallId: string;
      modelToolCallId: string;
      state: ToolPartDtoState;
    }
  | {
      id: string;
      type: 'summary';
      source: 'assistant' | 'compaction' | 'system';
      text: string;
    }
  | {
      id: string;
      type: 'patch';
      files: Array<{ path: string; change: 'create' | 'delete' | 'update' }>;
    };
```

旧 `MessagePart` union 应被替换或版本化。旧 `{ type: 'tool_result' }` 不再新增。

## 9. ContextBuilder

### 9.1 模块

```text
packages/agent/src/context/
  schema.ts
  builder.ts
  visibility.ts
  compact-boundary.ts
  reminders.ts
  system-context.ts
  size-guard.ts
  ai-sdk-message-adapter.ts
  ai-sdk-tool-adapter.ts
  ai-sdk-request-adapter.ts
```

Server side：

```text
apps/server/src/repositories/message-part-repository.ts
apps/server/src/services/session/part-service.ts
apps/server/src/services/session/context-service.ts
```

### 9.2 BuiltContext

```ts
export type BuiltContext = {
  system: ContextSystemBlock[];
  messages: ContextMessage[];
  lastUser: ContextLastUser;
  debug: ContextBuildDebug;
  estimate: ContextEstimate;
};

export type ContextSystemBlock = {
  source:
    | 'core'
    | 'environment'
    | 'instruction'
    | 'skill_list'
    | 'memory'
    | 'user_system'
    | 'format';
  text: string;
};

export type ContextLastUser = {
  messageId: string;
  agentName: string;
  model: { providerId: string; modelId: string };
  runtime?: MessageRuntimeMetadata;
};

export type ContextMessage = {
  role: 'user' | 'assistant';
  sourceMessageId: string;
  parts: ContextPart[];
};

export type ContextPart =
  | { type: 'text'; text: string; sourcePartId: string }
  | {
      type: 'file';
      mime: string;
      url: string;
      filename?: string;
      sourcePartId: string;
    }
  | {
      type: 'tool';
      toolName: string;
      toolCallId: string;
      modelToolCallId: string;
      input: Record<string, unknown>;
      outputText?: string;
      errorText?: string;
      errorReason?: 'execution_denied' | 'tool_error' | 'interrupted';
      attachments?: FileAttachment[];
      sourcePartId: string;
    };
```

### 9.3 Build flow

```text
ContextBuilder.build(sessionId)
  -> load MessageWithParts[]
  -> reject incompatible legacy sessions
  -> filterCompacted(messages) no-op in phase 1
  -> insertReminders(messages, runtimeState) no-op-capable
  -> normalize order
  -> project model-visible parts
  -> repair dangling tool parts
  -> build system blocks via SystemContextBuilder
  -> estimate size
  -> return BuiltContext
```

Pipeline boundaries:

| Stage                                 | Responsibility                                               | Phase 1 behavior                                                                             |
| ------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `load MessageWithParts[]`             | Read transcript from DB only.                                | No adapter or processor may read DB directly for context replay.                             |
| `reject incompatible legacy sessions` | Stop old `role='tool'` / missing part sessions.              | Return non-runnable error before provider call.                                              |
| `filterCompacted`                     | Apply compact boundary.                                      | No-op, but all downstream stages consume its output.                                         |
| `insertReminders`                     | Insert synthetic model-visible reminder text.                | Interface exists; may return unchanged messages.                                             |
| `normalize order`                     | Stable message and part ordering.                            | Sort by message time/id and part `order`.                                                    |
| `project model-visible parts`         | Convert persisted parts to `ContextPart`.                    | Apply visibility table below.                                                                |
| `repair dangling tool parts`          | Prevent pending/running tool calls from leaking to provider. | Convert recoverable interrupted tools to error before provider call, except active approval. |
| `build system blocks`                 | Build all system text in one place.                          | Core prompt + environment + instructions + user system + format hints.                       |
| `estimate size`                       | Estimate chars/tokens and skipped parts.                     | Required before provider request.                                                            |

`insertReminders` must stay in the main path even if phase 1 is no-op. Expected reminder types:

| Reminder                   | Purpose                                                         |
| -------------------------- | --------------------------------------------------------------- |
| waiting approval reminder  | Explain rejected/interrupted tool execution to the model.       |
| max steps reminder         | Prevent unbounded tool loops from silently continuing.          |
| compact continue reminder  | Resume task after a future compact summary.                     |
| user interruption reminder | Include mid-run user updates once interruption support exists.  |
| context too large reminder | Explain that a large attachment or history cannot be processed. |

### 9.4 SystemContextBuilder

System context is explicit. It must not be hidden inside `AiSdkRequestAdapter.toRequest()`.

```ts
export type SystemContextInput = {
  session: SessionInfo;
  workspaceRoot: string;
  agentName: string;
  model: { providerId: string; modelId: string };
  lastUserRuntime?: MessageRuntimeMetadata;
};

export function buildSystemContext(
  input: SystemContextInput
): ContextSystemBlock[];
```

System block order:

1. `core`: agent/provider base prompt。
2. `environment`: workspace、platform、date、shell/runtime constraints。
3. `instruction`: project instructions such as `AGENTS.md`。
4. `skill_list`: available skills；phase 1 may be empty。
5. `memory`: explicit memory；phase 1 empty。
6. `user_system`: `PromptInput.system` from the last user message。
7. `format`: structured output instruction if `PromptInput.format` requires it。

The adapter only joins `ContextSystemBlock[]` into AI SDK `system`. It must not create hidden system text on its own.

### 9.5 Visibility rules

| Part                   | Rule                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `text`                 | Included unless `ignored`.                                                                                              |
| `file`                 | Included only if AI SDK/provider supports mime and size guard accepts it.                                               |
| `reasoning`            | Persisted but not included in phase 1.                                                                                  |
| `tool completed`       | Included as `ContextPart.type='tool'`, projected to assistant tool-call plus tool-result.                               |
| `tool error`           | Included as `ContextPart.type='tool'` with `errorText` and `errorReason`, projected to AI SDK error/denied tool result. |
| `tool pending/running` | Not sent while waiting approval; otherwise converted to interrupted error before provider call.                         |
| `patch`                | Not included.                                                                                                           |
| `compaction`           | Not included in phase 1.                                                                                                |

## 10. Context size guard

弃用 provider-side conversation state 后，每轮都重传历史。第一阶段即使不做 compact，也必须有硬保护。

```ts
export type ContextSizeGuardConfig = {
  maxEstimatedTokens: number;
  maxEstimatedChars: number;
  maxEstimatedToolSchemaChars: number;
};
```

规则：

1. `ContextBuilder` 返回 transcript/system/files 的 char/token 粗估。
2. `ToolRegistry.resolveTools()` 后必须估算 resolved tool schema 体积。
3. `AiSdkRequestAdapter` 生成 request 后必须做一次 request-level 估算，用于捕捉 projection 后额外开销。
4. 超过任一阈值时，不调用 provider。
5. session 标记 failed 或 blocked。
6. 返回明确错误：`context_too_large_compact_not_implemented`。

Size guard inputs:

```text
BuiltContext
  + ResolvedTool[] schema estimate
  + AiSdkTurnRequest projection estimate
  -> ContextSizeGuard.assertFits(...)
```

Tool schemas must be counted because large JSON schemas can dominate prompt size even when transcript text is small.

这是第一阶段必做项，不是后续优化。

## 11. AI SDK adapter and model client

### 11.1 Dependency changes

运行时依赖从 OpenAI native SDK 切到 AI SDK：

| Package          | Action                           | Reason                                                       |
| ---------------- | -------------------------------- | ------------------------------------------------------------ |
| `openai`         | Remove from runtime packages     | 不再直接调用 OpenAI Responses。                              |
| `ai`             | Add                              | 使用 `streamText`、`ModelMessage`、`ToolSet`、stream parts。 |
| `@ai-sdk/openai` | Add if OpenAI provider is needed | OpenAI 仅作为 AI SDK provider。                              |

`apps/server` 和 `packages/agent` 中不得直接 import `openai`。如果需要 OpenAI model，应通过 provider factory 创建：

```ts
import { openai } from '@ai-sdk/openai';

const model = openai(modelId);
```

### 11.2 请求生成

目标接口：

```ts
import type { LanguageModel, ModelMessage, ToolSet } from 'ai';

export type AiSdkTurnRequest = {
  providerId: string;
  modelId: string;
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  toolPolicies: ResolvedToolPolicyMap;
  toolExecutionMode: 'manual';
  providerOptions?: Record<string, unknown>;
};

export function toAiSdkTurnRequest(input: {
  context: BuiltContext;
  model: { providerId: string; modelId: string };
  tools: ResolvedTool[];
}): AiSdkTurnRequest;
```

`system` 是 system 唯一承载位置。不要同时把同一 system 内容塞进 `messages`。

`toolPolicies` is application metadata. It must be derived from `ResolvedTool[]` before conversion to AI SDK `ToolSet`, and it is the only source `SessionProcessor` may use to decide approval behavior for a model-emitted tool call.

RunLoop owns multi-step behavior. In phase 1 the AI SDK call must be a single model step: tools are exposed for model selection, but tool execution and continuation are owned by `RunLoop` + `ToolExecutor`. Do not let AI SDK automatically execute tools and continue hidden turns in phase 1.

### 11.3 ModelMessage projection

Adapter 只做 shape projection，不做 DB 查询、不做权限判断、不执行工具。

Representative projection:

```ts
const messages: ModelMessage[] = [
  {
    role: 'user',
    content: [{ type: 'text', text: '...' }]
  },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '...' },
      {
        type: 'tool-call',
        toolCallId: tool.modelToolCallId,
        toolName: tool.toolName,
        args: tool.input
      }
    ]
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: tool.modelToolCallId,
        toolName: tool.toolName,
        output: toAiSdkToolResultOutput(tool)
      }
    ]
  }
];
```

Tool result output mapping:

| ToolPart state                                            | AI SDK `ToolResultPart.output`                                                      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `completed` with plain text                               | `{ type: 'text', value: outputText }`                                               |
| `completed` with structured payload intentionally exposed | `{ type: 'json', value: payload }`                                                  |
| `error.reason='execution_denied'`                         | `{ type: 'execution-denied', reason: errorText }`                                   |
| `error.reason='tool_error'`                               | `{ type: 'error-text', value: errorText }`                                          |
| `error.reason='interrupted'`                              | `{ type: 'error-text', value: errorText }`                                          |
| completed output with attachments                         | `{ type: 'content', value: [...] }` after adapter-level truncation and media checks |

Exact field names must compile against the pinned AI SDK version. The RFC assumes AI SDK v6-style `ToolCallPart.args` and `ToolResultPart.output`. If the installed AI SDK version differs, the adapter owns that conversion and tests must compile against `ModelMessage[]`.

Adapter requirements：

1. User text/file parts must preserve transcript order.
2. Assistant text and tool-call parts must preserve part order inside the assistant message.
3. Completed/error `ToolPart` must produce an assistant tool-call and a matching tool-result with the same `modelToolCallId`.
4. A completed/error tool without `modelToolCallId` must fail context build before provider call。
5. Tool errors and approval denials must use AI SDK error/denied output types instead of plain success text。
6. No OpenAI Responses `ResponseInputItem[]` or `function_call_output` shape may appear outside an optional provider-specific adapter test fixture。
7. Add one contract test with a representative user -> assistant -> tool-call -> tool-result sequence compiling against AI SDK types。

### 11.4 ToolSet adapter

`ResolvedTool[]` is provider-agnostic. `AiSdkToolAdapter` maps it to AI SDK `ToolSet`。

```ts
export function toAiSdkToolSet(input: {
  tools: ResolvedTool[];
  executionMode: 'manual';
}): ToolSet;
```

Phase 1 rule：

1. AI SDK tools expose name、description、input schema。
2. AI SDK tools must not define `execute` in phase 1。
3. AI SDK tools do not execute local side effects directly。
4. Tool execution happens after `SessionProcessor` returns `tool_calls`。
5. Future `execute` wrappers are allowed only if they delegate to `ToolExecutor` and preserve approval/persistence semantics。
6. Future `execute` wrappers must not bypass approval, must write the same `ToolPart` state transitions, and must not let AI SDK continue hidden model steps outside `RunLoop`。

Manual mode shape:

```ts
tool({
  description,
  inputSchema
  // no execute in phase 1
});
```

Future execute wrapper shape:

```ts
tool({
  description,
  inputSchema,
  execute: async (input, options) => {
    return toolExecutor.executeFromAiSdk({
      toolName,
      modelToolCallId: options.toolCallId,
      input,
      sessionId,
      approvalMode: 'must_already_be_approved'
    });
  }
});
```

### 11.5 AI SDK stream event mapping

`SessionProcessor` consumes AI SDK stream events and persists application parts。

| AI SDK stream event       | Persistence behavior                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| text start/delta/end      | Create/update assistant `TextPart`。                                                                                                      |
| reasoning start/delta/end | Create/update `ReasoningPart` if provider emits reasoning。                                                                               |
| tool input start/delta    | Create/update `ToolPart.pending.rawInput` if streamed input is available。                                                                |
| tool call                 | Create/update `ToolPart.pending` with `modelToolCallId`、tool name、parsed input; look up `request.toolPolicies[toolName]` for approval。 |
| finish step / finish      | Persist finish reason、usage、provider metadata。                                                                                         |
| error / abort             | Mark assistant message and running parts failed/cancelled。                                                                               |

The processor must not invoke local tools while handling these events。

If a tool call references a missing or disabled `toolPolicies[toolName]`, `SessionProcessor` must write the `ToolPart` as error and return `failed`; it must not execute the tool or ask the adapter/ToolSet to infer permission.

### 11.6 Model client changes

Current `model-client.ts` must be replaced or simplified：

1. Remove direct `openai` client construction。
2. Remove `previousResponseId` from runtime input。
3. Remove `statelessMode` from runtime config。
4. Use AI SDK `streamText` as the only model streaming entry point。
5. Always pass resolved `tools` from `ToolRegistry.resolveTools()`。
6. Keep system text in AI SDK `system` only。
7. Capture AI SDK finish reason、usage、response/provider metadata for reconciliation。

## 12. Tool resolution and execution

### 12.1 ToolRegistry.resolveTools

Tools are resolved every model turn. The adapter must not receive a global static tool list。

```ts
export type ToolResolutionInput = {
  session: SessionInfo;
  agentName: string;
  model: { providerId: string; modelId: string };
  lastUser: ContextLastUser;
  context: BuiltContext;
};

export type ResolvedTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  approval: 'never' | 'required';
  enabled: boolean;
  source: 'builtin' | 'mcp' | 'plugin' | 'structured_output';
};

export type ResolvedToolPolicy = {
  name: string;
  approval: ResolvedTool['approval'];
  enabled: boolean;
  source: ResolvedTool['source'];
};

export type ResolvedToolPolicyMap = Record<string, ResolvedToolPolicy>;

export function resolveTools(input: ToolResolutionInput): ResolvedTool[];
```

Resolution order:

1. Start with built-in registry tools。
2. Filter by provider/model capability。
3. Filter by agent permission。
4. Filter by session permission。
5. Apply `lastUser.runtime.toolOverrides` from `PromptInput.tools`。
6. Add dynamic MCP/plugin tools once those sources exist。
7. Add structured output helper tool if `lastUser.runtime.format` requires tool-based output for the selected provider。
8. Return provider-agnostic `ResolvedTool[]`; AI SDK `ToolSet` is produced by `AiSdkToolAdapter`。

Phase 1 can return a very small set, for example only `read_file`, but the call site must already be：

```text
ToolRegistry.resolveTools({ session, agentName, model, lastUser, context })
  -> AiSdkToolAdapter.toToolSet(resolvedTools)
  -> AiSdkRequestAdapter.toRequest(context, toolSet)
```

Boundary rules:

1. `resolveTools` does not execute tools。
2. `resolveTools` does not create `ToolPart` or `tool_calls` rows。
3. `resolveTools` is allowed to inspect context metadata and last user runtime settings。
4. `resolveTools` is the source of truth for approval policy。
5. The AI SDK adapter is responsible only for provider/tool shape conversion, not permission decisions。

### 12.2 Tool result

```ts
export type ToolResult = {
  outputText: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  attachments?: FileAttachment[];
};
```

`outputText` is model-visible. `payload` is machine/UI data and not model-visible unless explicitly serialized into `outputText`。

### 12.3 ToolExecutor lifecycle

```text
model emits AI SDK tool call
  -> SessionProcessor creates ToolPart pending with modelToolCallId/input
  -> SessionProcessor creates tool_calls row with same modelToolCallId
  -> SessionProcessor returns tool_calls or paused_for_approval
  -> RunLoop calls ToolExecutor for auto-approved pending ToolParts
  -> ToolExecutor updates ToolPart running
  -> execute tool
  -> ToolExecutor updates ToolPart completed/error
  -> ToolExecutor updates tool_calls completed/failed
  -> RunLoop rebuilds full context
```

`SessionProcessor` is a stream-to-persistence boundary. It may persist model-emitted tool call parts, but it must not run local tools. `ToolExecutor` is the only component that invokes local tool implementations。

```ts
export type ToolExecutorResult =
  | { kind: 'completed'; executedPartIds: string[] }
  | { kind: 'paused_for_approval'; checkpoint: WaitingApprovalCheckpoint }
  | { kind: 'failed'; error: string };
```

If a tool implementation throws, the executor writes `ToolPart.state.status='error'` and returns `completed` so the next model turn can observe the error unless the failure is an infrastructure failure that prevents persistence。

### 12.4 Approval blocking rule

When session is `waiting_approval`:

1. New user prompt is rejected with 409。
2. RunLoop must not call model。
3. ContextBuilder may build debug preview, but provider call is forbidden。
4. Only approval resolution may continue the run。

If recovery finds a pending/running tool without active approval, it must mark the ToolPart as error with `Tool execution was interrupted` before any provider call。

## 13. RunLoop and SessionProcessor

### 13.1 RunLoop

Old state:

```text
currentInput
previousResponseId
```

New state:

```text
sessionId only
```

Target loop:

```ts
for (let step = 0; step < maxSteps; step++) {
  const runtime = await sessionRuntime.load(sessionId);
  if (runtime.status === 'cancelled') return { kind: 'cancelled' };
  if (runtime.status === 'waiting_approval')
    return { kind: 'paused_for_approval' };

  const context = await contextBuilder.build({
    sessionId,
    workspaceRoot,
    model
  });

  const resolvedTools = await toolRegistry.resolveTools({
    session,
    agentName,
    model,
    lastUser: context.lastUser,
    context
  });

  const request = aiSdkRequestAdapter.toRequest({
    context,
    model,
    tools: resolvedTools
  });
  contextSizeGuard.assertFits({ context, resolvedTools, request });
  const result = await processor.processTurn({
    request,
    sessionId,
    workspaceRoot
  });

  if (result.kind === 'completed') return result;
  if (result.kind === 'paused_for_approval') return result;
  if (result.kind === 'tool_calls') {
    const toolResult = await toolExecutor.executePendingToolParts(
      result.toolParts
    );
    if (toolResult.kind === 'paused_for_approval') return toolResult;
    if (toolResult.kind === 'failed') return toolResult;
    continue;
  }
  if (result.kind === 'failed') return result;
}

return { kind: 'max_steps_exceeded' };
```

### 13.2 ProcessorResult

```ts
export type ProcessorResult =
  | { kind: 'completed'; finishReason: FinishReason }
  | { kind: 'tool_calls'; assistantMessageId: string; toolParts: ToolPart[] }
  | { kind: 'paused_for_approval'; checkpoint: WaitingApprovalCheckpoint }
  | { kind: 'failed'; error: string };

export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool-calls'
  | 'content-filter'
  | 'cancelled'
  | 'error'
  | 'other'
  | 'unknown';
```

No `nextInput`. No provider response id continuation state。

AI SDK finish reason mapping:

| AI SDK finish reason    | Internal `FinishReason` |
| ----------------------- | ----------------------- |
| `stop`                  | `stop`                  |
| `length`                | `length`                |
| `tool-calls`            | `tool-calls`            |
| `content-filter`        | `content-filter`        |
| `error`                 | `error`                 |
| `other`                 | `other`                 |
| aborted by user/session | `cancelled`             |
| missing/unrecognized    | `unknown`               |

### 13.3 Final response reconciliation

At stream end, `SessionProcessor` must reconcile AI SDK final output before returning a terminal `ProcessorResult`。

Persisted fields:

| AI SDK/provider value  | Persisted location                                           | Required for replay                      |
| ---------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| response id if exposed | `MessageInfo.modelResponseId`                                | No, debug/audit only。                   |
| provider metadata      | `MessageInfo.providerMetadata` / `ToolPart.providerMetadata` | No, debug/audit only。                   |
| AI SDK `toolCallId`    | `ToolPart.modelToolCallId`                                   | Yes, for tool-call/tool-result pairing。 |
| finish reason          | `MessageInfo.finishReason`                                   | Yes, for loop exit/debug。               |
| token usage            | `MessageInfo.tokenUsage`                                     | No, budget/compact/debug。               |

Reconciliation rules:

1. Assistant text does not require provider output item id in the AI SDK path。
2. If any model tool call lacks `modelToolCallId`, mark the corresponding `ToolPart` error and return `failed`; tool result pairing would be impossible。
3. If final response reports tool calls, read `request.toolPolicies` to decide whether each call requires approval。
4. If any tool call requires approval, create approval/checkpoint and return `paused_for_approval`。
5. If all tool calls are auto tools, return `tool_calls`。
6. If final response has no tool calls, return `completed` with normalized finish reason。
7. `modelResponseId` / provider response metadata is never used as continuation state。
8. Usage and finish reason must be persisted even when the model emits tool calls。

This is the AI SDK version of final response reconciliation. It preserves the original requirement to make replay deterministic, but removes the OpenAI Responses requirement to persist assistant output item ids。

### 13.4 Loop exit policy

| Condition                                               | RunLoop behavior                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| no tool call and assistant completed                    | Stop with `completed`。                                                                  |
| tool calls emitted and all auto tools completed         | Continue; next iteration rebuilds context from DB。                                      |
| tool call requires approval                             | Pause session with `WaitingApprovalCheckpoint`。                                         |
| tool failed but error was written to `ToolPart`         | Continue; model sees error and decides next action。                                     |
| tool executor infrastructure failure before persistence | Stop with `failed`。                                                                     |
| `maxSteps` exceeded                                     | Stop with `max_steps_exceeded`; optionally append synthetic max-steps reminder/message。 |
| context too large                                       | Stop with `context_too_large_compact_not_implemented` before provider call。             |
| user cancelled                                          | Mark running assistant/tool parts aborted or failed, then stop with `cancelled`。        |
| session already waiting approval                        | Do not call model; return `paused_for_approval`。                                        |

### 13.5 WaitingApprovalCheckpoint

```ts
export type WaitingApprovalCheckpoint = {
  kind: 'waiting_approval';
  sessionId: string;
  messageId: string;
  partId: string;
  toolCallId: string;
  modelToolCallId: string;
  updatedAt: string;
};
```

## 14. Compact-ready fields

Phase 1 does not compact, but must include:

1. `MessageInfo.summary`
2. `MessageInfo.compactedByMessageId`
3. `CompactionPart`
4. `ToolState.completed.compactedAt`
5. `ContextBuilder.filterCompacted()` no-op
6. `ContextBuildDebug.skippedParts`

Future compact flow:

```text
context too large or user compact
  -> create user message + CompactionPart
  -> build stripped-media context
  -> model generates summary assistant message(summary=true)
  -> filterCompacted keeps summary + recent tail
```

## 15. SSE/API compatibility

Existing event names remain for phase 1:

| Event                       | Source after refactor                  |
| --------------------------- | -------------------------------------- |
| `message.created`           | MessageInfo + assembled DTO from parts |
| `message.delta`             | TextPart delta                         |
| `message.completed`         | MessageInfo status completed           |
| `tool.running`              | ToolPart running + tool_calls row      |
| `tool.completed`            | ToolPart completed + tool_calls row    |
| `tool.failed`               | ToolPart error + tool_calls row        |
| `approval.created/resolved` | approvals + checkpoint with part ids   |

Part-level events can be added later:

```ts
{
  type: 'message.part.created';
  sessionId;
  messageId;
  part;
}
{
  type: 'message.part.delta';
  sessionId;
  messageId;
  partId;
  field;
  delta;
}
{
  type: 'message.part.updated';
  sessionId;
  messageId;
  part;
}
```

## 16. Implementation plan

### Phase 0: destructive migration and dependency switch

1. Add DB migration for new message fields and `message_parts`。
2. Delete old session runtime data or require DB reset。
3. Remove legacy `role='tool'` creation path。
4. Remove `previous_response_id` from checkpoint model。
5. Remove `statelessMode` from model client config。
6. Remove `openai` package from runtime packages。
7. Add `ai` and provider packages such as `@ai-sdk/openai`。

### Phase 1: schema and repositories

1. Add internal context schema。
2. Add message part repository。
3. Add `listMessagesWithParts(sessionId)`。
4. Assemble `MessageDto.content` from parts。
5. Add ToolPart <-> tool_calls transactional update helpers。
6. Persist `modelToolCallId` instead of OpenAI `call_id` / item ids。

### Phase 2: ContextBuilder and size guard

1. Implement `ContextBuilder.build()`。
2. Implement `filterCompacted()` no-op。
3. Implement `insertReminders()` no-op-capable boundary。
4. Implement visibility projection。
5. Implement dangling tool repair。
6. Implement `SystemContextBuilder.build()` for core/environment/instructions/user system/format blocks。
7. Implement size guard with BuiltContext, resolved tool schema, and projected AI SDK request estimates。
8. Add context debug output。

### Phase 2.5: Prompt input and tool resolution

1. Change route payload handling to produce `PromptInput`。
2. Implement `PromptNormalizer.createUserMessage()`。
3. Persist `MessageInfo.runtime` for system/tools/format/variant。
4. Implement `ToolRegistry.resolveTools()` with provider/model, agent/session, and last-user override filters。
5. Keep phase 1 resolved tools minimal, but ensure RunLoop calls `resolveTools()` every turn。

### Phase 3: AI SDK adapter and model client

1. Implement `toAiSdkTurnRequest()`。
2. Use AI SDK `system` for system blocks。
3. Generate SDK-valid `ModelMessage[]`。
4. Reconstruct assistant tool-call and tool-result pairs using `modelToolCallId`。
5. Build `toolPolicies` from `ResolvedTool[]` and include them in `AiSdkTurnRequest`。
6. Implement `AiSdkToolAdapter.toToolSet()` in manual no-`execute` mode。
7. Implement `AiSdkModelClient.streamText()` wrapper。
8. Add adapter contract tests compiling against AI SDK types。

### Phase 4: Processor, ToolExecutor, and RunLoop

1. Rewrite RunLoop to rebuild context every iteration。
2. Remove `currentInput` and provider response id continuation state。
3. Consume AI SDK `fullStream` in `SessionProcessor`。
4. Write assistant text to `TextPart`。
5. Write model tool call to `ToolPart.pending`。
6. Use `request.toolPolicies` to decide approval vs auto tool call。
7. Reconcile finish reason、token usage、model tool call ids、provider metadata before returning `ProcessorResult`。
8. Return `tool_calls` instead of executing tools inside `SessionProcessor`。
9. Implement `ToolExecutor.executePendingToolParts()` for running/completed/error transitions。
10. Store provider response metadata only for debug。
11. Enforce `maxSteps`, context-too-large, approval, cancellation, and failed persistence exit policies。

### Phase 5: approval resume

1. Checkpoint by `messageId/partId/toolCallId/modelToolCallId`。
2. Resume by loading ToolPart。
3. Reject new prompts while waiting approval。
4. After approval, execute/update ToolPart, then full rebuild。

## 17. Tests

Required tests:

| Test                         | Expected                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| destructive migration        | old session runtime data is removed or marked incompatible。                                                |
| no openai runtime dependency | server/agent runtime code does not import `openai` package。                                                |
| no previous response id      | request path has no `previous_response_id` or provider conversation id。                                    |
| no stateless mode            | model client config has no `statelessMode`; tools still sent。                                              |
| AI SDK request contract      | adapter output compiles as `system + ModelMessage[] + ToolSet`。                                            |
| tool policy propagation      | `AiSdkTurnRequest.toolPolicies` is derived from `ResolvedTool[]` and used by processor approval decisions。 |
| manual tool mode             | phase 1 AI SDK tools do not define `execute` and cannot execute local side effects。                        |
| AI SDK tool result output    | completed/error/denied ToolPart maps to AI SDK `ToolResultPart.output` correctly。                          |
| text projection              | user/assistant text appears in order。                                                                      |
| ignored text                 | ignored part is skipped。                                                                                   |
| tool id boundary             | internal `toolCallId` is not used as AI SDK `modelToolCallId` unless explicitly copied from model event。   |
| completed tool adapter       | ToolPart produces assistant tool-call + matching tool-result。                                              |
| error tool adapter           | ToolPart error produces tool-result with error text。                                                       |
| dangling tool repair         | pending/running cannot produce dangling provider call。                                                     |
| metadata invisibility        | title/metadata/payload/timestamps/provider metadata do not enter model context。                            |
| system context               | system blocks are generated by `SystemContextBuilder` and emitted only through AI SDK `system`。            |
| context size guard           | oversized context fails before provider request。                                                           |
| tool schema size guard       | oversized resolved tool schemas fail before provider request。                                              |
| processor/executor split     | SessionProcessor persists tool calls but does not execute local tools。                                     |
| final reconciliation         | finish reason、usage、modelToolCallId、provider metadata are persisted at stream end。                      |
| approval blocked prompt      | prompt while waiting approval returns conflict。                                                            |
| approval resume              | resume uses part ids and full context rebuild。                                                             |
| DTO assembly                 | MessageDto.content is assembled from parts。                                                                |
| recovery                     | process restart can rebuild context from DB only。                                                          |

## 18. Acceptance criteria

1. `openai` package is removed from runtime code paths。
2. AI SDK is the only model streaming boundary。
3. `previous_response_id` is fully removed from runtime request construction。
4. `statelessMode` is deleted。
5. Old session runtime history is destructively removed or made non-runnable。
6. `Message + Part` is the only context truth。
7. `ToolPart.modelToolCallId` is persisted and used for AI SDK tool-call/tool-result pairing。
8. `tool_calls.id` remains internal and is never used as model/provider pairing id。
9. AI SDK adapter emits SDK-valid full input every turn。
10. System context is emitted only through AI SDK `system` in phase 1。
11. `AiSdkTurnRequest.toolPolicies` carries approval policy from `ResolvedTool[]` to `SessionProcessor`。
12. Phase 1 AI SDK tools are manual no-`execute` tools。
13. Tool execution is owned by `ToolExecutor`, not by `SessionProcessor` or hidden AI SDK auto steps。
14. Final response reconciliation persists normalized finish reason、usage、tool call ids、provider metadata。
15. Context size guard blocks oversized transcript, tool schemas, or projected AI SDK requests before provider call。
16. Approval resume no longer depends on provider response id。
17. SSE/API compatibility is preserved through DTO assembly。
18. Unit tests cover adapter pairing, context visibility, approval resume, no previous id, AI SDK request contract, tool policy propagation, manual tool mode, and no `openai` runtime import。

## 19. Risks

| Risk                                                    | Impact                                       | Mitigation                                                                                       |
| ------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Every turn resends transcript                           | Higher token cost and faster overflow        | Mandatory size guard; compact next。                                                             |
| AI SDK message/tool shape changes across major versions | Invalid requests or broken tool replay       | Pin AI SDK major; compile adapter contract tests against `ModelMessage[]` and `ToolSet`。        |
| Hidden AI SDK auto tool loop                            | Tool execution bypasses approval/persistence | Use manual execution mode; configure one-step model call; keep ToolExecutor boundary。           |
| Tool id confusion                                       | tool-result pairing breaks                   | Separate internal `toolCallId` and model-visible `modelToolCallId`。                             |
| Provider metadata assumptions                           | Cross-provider replay becomes brittle        | Provider metadata is debug-only; replay depends on `Message + Part` and `modelToolCallId` only。 |
| Approval recovery changes                               | Existing checkpoint shape invalid            | Destructive migration; new checkpoint schema。                                                   |
| Frontend part rendering lag                             | UI may not know new part shape               | Assemble old-compatible MessageDto from parts。                                                  |

## 20. Follow-up work

After this RFC lands:

1. Implement `read_file/glob/grep` minimum loop。
2. Implement tool output truncation。
3. Implement old tool result prune。
4. Implement compact summary and real `filterCompacted()`。
5. Implement project instructions / AGENTS。
6. Implement skills。
7. Implement explicit memory file。
8. Consider MCP after `ToolRegistry.resolveTools()` and `AiSdkToolAdapter` are stable。
9. Consider RAG/vector index only after transcript + compact are stable。
