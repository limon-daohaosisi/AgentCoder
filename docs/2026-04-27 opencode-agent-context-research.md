# opencode Agent 请求格式、Tools、上下文与记忆机制研究

研究对象：`../opencode`，重点代码路径为 `../opencode/packages/opencode/src`。

研究重点：不关注 provider/model adapter 的具体适配细节，只关注 opencode 内部统一请求格式、tools、上下文管理、长期记忆、短期记忆、RAG，以及 tool result 和各类记忆进入模型上下文的算法。

## 1. 结论摘要

opencode 的核心上下文系统不是一个单独的 `ContextManager`，而是由 `SessionPrompt.runLoop`、`MessageV2`、`SessionProcessor`、`SessionCompaction`、`InstructionPrompt`、`ToolRegistry` 和 `LLM.stream` 共同组成的一条 pipeline。

最重要的结论如下：

| 主题                   | 结论                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 统一内部请求格式       | 持久化格式是自定义 `MessageV2.Info + MessageV2.Part[]`，模型调用前的统一请求对象是 `LLM.StreamInput`，其中 `messages` 已转换为 AI SDK `ModelMessage[]`。                                         |
| 模型调用入口           | 主会话链路统一走 `LLM.stream -> streamText({ messages, tools, model, ... })`，未发现主 chat loop 使用 `generateText`。                                                                           |
| system prompt          | `agent.prompt` 或 provider prompt、环境信息、skill 列表、AGENTS/CLAUDE/CONTEXT instructions、用户消息级 `system` 合并后通常作为 `role: "system"` message prepend 到 `messages`。                 |
| tool result 进入上下文 | completed tool 会进入后续上下文，包含 `toolName`、`toolCallId`、`input`、`output`、可选 `attachments`、同模型下的 provider call metadata。`title`、`state.metadata`、`time` 默认不进模型上下文。 |
| 短期记忆               | 当前 session 的 SQLite messages/parts、tool outputs、file reads、loaded skill content、subtask result、todowrite output、compaction summary。                                                    |
| 长期记忆               | 未发现自动长期用户记忆或跨 session 自动召回机制。AGENTS/global instructions/skills 是长期配置型上下文，不是 learned memory。                                                                     |
| RAG                    | 未发现本地 embedding、vector DB、chunk indexing、自动语义召回。只有显式 `grep/glob/read`、外部 Exa `codesearch` 工具，以及 provider 协议层的 vector store 字段。                                 |
| 压缩策略               | 自动 compaction 基于上一轮 assistant token usage 与模型上下文限制；成功后只保留 compaction summary 之后的消息。旧 tool output 会按 token 阈值被 prune 成占位文本。                               |

关键源码引用：

| 内容                                   | 引用                                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `LLM.StreamInput` 和 `streamText` 调用 | `../opencode/packages/opencode/src/session/llm.ts:25-37`, `../opencode/packages/opencode/src/session/llm.ts:259-333`                |
| 主 loop 构造 system/messages/tools     | `../opencode/packages/opencode/src/session/prompt.ts:1352-1572`                                                                     |
| `PromptInput` 外部输入格式             | `../opencode/packages/opencode/src/session/prompt.ts:1747-1812`                                                                     |
| `MessageV2` part/message schema        | `../opencode/packages/opencode/src/session/message-v2.ts:87-512`                                                                    |
| `MessageV2.toModelMessages`            | `../opencode/packages/opencode/src/session/message-v2.ts:576-810`                                                                   |
| compacted 历史过滤                     | `../opencode/packages/opencode/src/session/message-v2.ts:906-922`                                                                   |
| tool 定义接口                          | `../opencode/packages/opencode/src/tool/tool.ts:17-91`                                                                              |
| tool 注册                              | `../opencode/packages/opencode/src/tool/registry.ts:64-194`                                                                         |
| tool result 落盘                       | `../opencode/packages/opencode/src/session/processor.ts:149-247`                                                                    |
| compaction/prune                       | `../opencode/packages/opencode/src/session/compaction.ts:91-139`, `../opencode/packages/opencode/src/session/compaction.ts:141-371` |
| overflow 判断                          | `../opencode/packages/opencode/src/session/overflow.ts:8-22`                                                                        |
| AGENTS/instruction 加载                | `../opencode/packages/opencode/src/session/instruction.ts:72-190`                                                                   |
| skills 加载和注入                      | `../opencode/packages/opencode/src/skill/index.ts:137-258`, `../opencode/packages/opencode/src/session/system.ts:63-75`             |

## 2. 总体数据流

opencode 的主请求链路如下：

```text
User/API input
  -> SessionPrompt.PromptInput
  -> createUserMessage
  -> MessageV2.User + MessageV2.Part[]
  -> SQLite message/part tables
  -> MessageV2.stream(sessionID)
  -> MessageV2.filterCompacted(...)
  -> insertReminders(...)
  -> MessageV2.toModelMessages(...)
  -> AI SDK ModelMessage[]
  -> SessionPrompt.resolveTools(...)
  -> LLM.StreamInput
  -> SessionProcessor.process(...)
  -> LLM.stream(...)
  -> streamText({ messages, tools, activeTools, model, ... })
  -> SessionProcessor saves text/reasoning/tool/usage parts back to MessageV2
```

这个 pipeline 的一个关键特征是：opencode 不直接把 provider-native message 保存为会话历史，而是保存自己的 `MessageV2` 结构。每轮调用模型前，再把 `MessageV2` 映射为 AI SDK 的 `ModelMessage[]`。

## 3. 统一内部请求格式

### 3.1 外部 prompt 输入：`PromptInput`

入口 schema 在 `../opencode/packages/opencode/src/session/prompt.ts:1747-1812`。

```ts
{
  sessionID: SessionID
  messageID?: MessageID
  model?: {
    providerID: ProviderID
    modelID: ModelID
  }
  agent?: string
  noReply?: boolean
  tools?: Record<string, boolean>
  format?: MessageV2.Format
  system?: string
  variant?: string
  parts: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>
}
```

这不是最终模型请求，而是 API/CLI/command 层传给 session prompt 的输入格式。它会先变成 `MessageV2.User` 和一组 `MessageV2.Part`，再持久化。

### 3.2 持久化消息格式：`MessageV2`

`MessageV2` 是 opencode 的会话事实流格式，定义在 `../opencode/packages/opencode/src/session/message-v2.ts:87-512`。

`MessageV2.User` 关键字段：

```ts
{
  id: MessageID
  sessionID: SessionID
  role: "user"
  time: { created: number }
  format?: OutputFormat
  summary?: {
    title?: string
    body?: string
    diffs: Snapshot.FileDiff[]
  }
  agent: string
  model: {
    providerID: ProviderID
    modelID: ModelID
  }
  system?: string
  tools?: Record<string, boolean>
  variant?: string
}
```

`MessageV2.Assistant` 关键字段：

```ts
{
  id: MessageID
  sessionID: SessionID
  role: "assistant"
  parentID: MessageID
  modelID: ModelID
  providerID: ProviderID
  agent: string
  path: { cwd: string; root: string }
  summary?: boolean
  cost: number
  tokens: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  structured?: any
  finish?: string
  error?: ...
}
```

`MessageV2.Part` 是 discriminated union，主要类型包括：

| part 类型     | 作用                                  | 是否可能进入模型上下文                                      |
| ------------- | ------------------------------------- | ----------------------------------------------------------- |
| `text`        | 用户文本或 assistant 文本             | 是，除非 `ignored`。                                        |
| `reasoning`   | 模型 reasoning stream                 | 是，作为 reasoning part；同模型时带 provider metadata。     |
| `file`        | 文件/附件 data URL 或 file url        | 是，但 `text/plain` 和 directory 通常已转成 text。          |
| `tool`        | tool call/result/error 状态           | 是，按 `toModelMessages` 规则映射。                         |
| `step-start`  | step snapshot 起点                    | 不直接作为有效 message；转换后会过滤纯 step-start message。 |
| `step-finish` | finish reason、tokens、cost、snapshot | 不直接进模型上下文。                                        |
| `patch`       | 文件 patch snapshot 信息              | 不直接进模型上下文。                                        |
| `compaction`  | 触发压缩的 user part                  | 是，转换为 `What did we do so far?`。                       |
| `subtask`     | 用户显式子任务 part                   | 是，转换为一段文本提示。                                    |
| `agent`       | 指定/切换 agent 的输入 part           | 不作为普通文本进入模型。                                    |

SQLite 表在 `../opencode/packages/opencode/src/session/session.sql.ts:14-103`：

| 表           | 内容                                                         |
| ------------ | ------------------------------------------------------------ |
| `session`    | session 元信息、parent、title、permission、summary diff 等。 |
| `message`    | `MessageV2.Info` 的 JSON，不含 `id/sessionID`。              |
| `part`       | `MessageV2.Part` 的 JSON，不含 `id/sessionID/messageID`。    |
| `todo`       | session todo list。                                          |
| `permission` | project permission ruleset。                                 |

### 3.3 模型调用前请求对象：`LLM.StreamInput`

模型调用前最核心的统一内部请求格式是 `LLM.StreamInput`，定义在 `../opencode/packages/opencode/src/session/llm.ts:25-37`。

```ts
{
  user: MessageV2.User
  sessionID: string
  model: Provider.Model
  agent: Agent.Info
  permission?: Permission.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
}
```

这里的 `messages` 已经是 AI SDK `ModelMessage[]`，不是 opencode 原始 `MessageV2`。`system` 仍然是 `string[]`，会在 `LLM.stream` 里与 agent/provider prompt、用户消息级 system 合并。

### 3.4 `MessageV2` 到 `ModelMessage[]` 的转换

核心函数是 `MessageV2.toModelMessages(input, model, options?)`，定义在 `../opencode/packages/opencode/src/session/message-v2.ts:576-810`。

转换过程：

| 输入 part                                                         | 转换结果                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| user `text` 且未 `ignored`                                        | UIMessage text part。                                                    |
| user `file` 且 mime 不是 `text/plain` / `application/x-directory` | UIMessage file part；`stripMedia` 时 image/pdf 变成文本占位。            |
| user `compaction`                                                 | text：`What did we do so far?`。                                         |
| user `subtask`                                                    | text：`The following tool was executed by the user`。                    |
| assistant `text`                                                  | assistant text part；同模型时保留 provider metadata。                    |
| assistant `reasoning`                                             | reasoning part；同模型时保留 provider metadata。                         |
| assistant completed `tool`                                        | `tool-${toolName}`，`state: "output-available"`，带 input/output。       |
| assistant error `tool`                                            | `tool-${toolName}`，`state: "output-error"`，带 input/errorText。        |
| assistant pending/running `tool`                                  | 合成为 `output-error`，errorText 为 `[Tool execution was interrupted]`。 |

`toModelMessages` 先构造 AI SDK `UIMessage[]`，再调用 `convertToModelMessages(...)` 得到 `ModelMessage[]`。tool output 的 conversion 通过 `toModelOutput` 指定，string output 变成 text tool result，object output 可以变成 text+media content。

### 3.5 最终传给 `streamText` 的结构

`SessionPrompt.runLoop` 在 `../opencode/packages/opencode/src/session/prompt.ts:1507-1528` 并行准备：

```ts
const [skills, env, instructions, modelMsgs] = await Promise.all([
  SystemPrompt.skills(agent),
  SystemPrompt.environment(model),
  InstructionPrompt.system(),
  MessageV2.toModelMessages(msgs, model)
]);

const system = [...env, ...(skills ? [skills] : []), ...instructions];

handle.process({
  user: lastUser,
  agent,
  permission: session.permission,
  sessionID,
  system,
  messages: modelMsgs,
  tools,
  model,
  toolChoice
});
```

`LLM.stream` 在 `../opencode/packages/opencode/src/session/llm.ts:101-160` 合成 system 和 messages。常规路径下，最终 `messages` 形状是：

```ts
[...system.map((x) => ({ role: 'system', content: x })), ...input.messages];
```

然后调用 `streamText`，关键参数在 `../opencode/packages/opencode/src/session/llm.ts:259-333`：

```ts
streamText({
  temperature,
  topP,
  topK,
  providerOptions,
  activeTools,
  tools,
  toolChoice,
  maxOutputTokens,
  abortSignal,
  headers,
  maxRetries,
  messages,
  model: wrapLanguageModel(...),
  experimental_telemetry,
})
```

OpenAI OAuth 和 GitLab workflow model 有特殊处理，但这属于 provider/workflow 差异，不影响 opencode 主体的统一内部格式判断。

## 4. Tools 系统

### 4.1 Tool 定义接口

工具基础接口在 `../opencode/packages/opencode/src/tool/tool.ts:17-91`。

`Tool.Context`：

```ts
{
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: Record<string, any>
  messages: MessageV2.WithParts[]
  metadata(input: { title?: string; metadata?: M }): void
  ask(input: Permission.RequestWithoutRuntimeFields): Promise<void>
}
```

`Tool.Def.execute` 标准返回：

```ts
Promise<{
  title: string;
  metadata: Record<string, any>;
  output: string;
  attachments?: Omit<MessageV2.FilePart, 'id' | 'sessionID' | 'messageID'>[];
}>;
```

`Tool.define` 会做两件通用处理：

| 处理     | 代码            | 说明                                                                      |
| -------- | --------------- | ------------------------------------------------------------------------- |
| 参数校验 | `tool.ts:60-71` | 用 zod parse 工具参数，不合法则抛错。                                     |
| 输出截断 | `tool.ts:72-86` | 若 metadata 未显式带 `truncated`，默认调用 `Truncate.output` 截断大输出。 |

### 4.2 Tool 注册和暴露

注册逻辑在 `../opencode/packages/opencode/src/tool/registry.ts:64-194`。

内置工具包括：`invalid`、`question`、`bash`、`read`、`glob`、`grep`、`edit`、`write`、`task`、`webfetch`、`todowrite`、`websearch`、`codesearch`、`skill`、`apply_patch`，以及实验性的 `lsp`、`batch`、`plan_exit`。

工具来源：

| 来源              | 处理                                                                               |
| ----------------- | ---------------------------------------------------------------------------------- |
| 内置工具          | `ToolRegistry.all` 返回固定工具数组。                                              |
| config tool files | 扫描 `{tool,tools}/*.{js,ts}`。                                                    |
| plugin tools      | `plugin.list()` 中的 `p.tool` 转成 `Tool.Info`。                                   |
| MCP tools         | `MCP.tools()` 返回 AI SDK `Tool`，在 `SessionPrompt.resolveTools` 中包装执行结果。 |

可见性过滤：

| 规则                                                                      | 代码                  |
| ------------------------------------------------------------------------- | --------------------- |
| `codesearch/websearch` 仅 opencode provider 或 `OPENCODE_ENABLE_EXA` 开启 | `registry.ts:163-166` |
| GPT patch 模式下 `apply_patch` 与 `edit/write` 互斥                       | `registry.ts:168-172` |
| agent/session permission 过滤                                             | `llm.ts:336-342`      |
| 用户消息级 `tools` 可禁用某 tool                                          | `llm.ts:341`          |

### 4.3 Tool 转 AI SDK Tool

`SessionPrompt.resolveTools` 在 `../opencode/packages/opencode/src/session/prompt.ts:384-547` 将内部工具暴露给模型。

内部 registry tool 的包装方式：

```ts
tools[item.id] = tool({
  id: item.id,
  description: item.description,
  inputSchema: jsonSchema(
    ProviderTransform.schema(model, z.toJSONSchema(item.parameters))
  ),
  execute(args, options) {
    const ctx = context(args, options);
    const result = await item.execute(args, ctx);
    return {
      ...result,
      attachments: result.attachments?.map(addPartIds)
    };
  }
});
```

MCP tool 的入口在 `../opencode/packages/opencode/src/mcp/index.ts:132-160`，先把 MCP tool definition 转成 AI SDK `dynamicTool`。随后 `SessionPrompt.resolveTools` 在 `../opencode/packages/opencode/src/session/prompt.ts:472-543` 统一处理 MCP 执行结果：

| MCP content type  | opencode result                                       |
| ----------------- | ----------------------------------------------------- |
| `text`            | 加入 `textParts`，最终 join 到 `output`。             |
| `image`           | 转成 data URL attachment。                            |
| `resource.text`   | 加入 `textParts`。                                    |
| `resource.blob`   | 转成 data URL attachment，filename 用 resource URI。  |
| `result.metadata` | 合并进 tool result metadata，但不直接进入模型上下文。 |

### 4.4 Tool 执行结果如何保存

模型产生 tool call 后，`SessionProcessor` 把 stream event 转成 `MessageV2.ToolPart`，关键代码在 `../opencode/packages/opencode/src/session/processor.ts:149-247`。

tool 生命周期：

| 阶段               | 保存结构                                                              |
| ------------------ | --------------------------------------------------------------------- |
| `tool-input-start` | 创建 `ToolPart`，`state.status = "pending"`，保存 raw input。         |
| `tool-call`        | 更新为 `running`，保存 parsed input、start time、provider metadata。  |
| `tool-result`      | 更新为 `completed`，保存 output/title/metadata/attachments/end time。 |
| `tool-error`       | 更新为 `error`，保存 input/error/end time。                           |

`ToolStateCompleted` 定义在 `../opencode/packages/opencode/src/session/message-v2.ts:300-317`：

```ts
{
  status: "completed"
  input: Record<string, any>
  output: string
  title: string
  metadata: Record<string, any>
  time: {
    start: number
    end: number
    compacted?: number
  }
  attachments?: FilePart[]
}
```

`ToolPart` 定义在 `../opencode/packages/opencode/src/session/message-v2.ts:341-350`：

```ts
{
  type: "tool"
  callID: string
  tool: string
  state: ToolState
  metadata?: Record<string, any>
}
```

注意两个 metadata 的区别：

| 字段                      | 来源                                | 是否默认进入模型上下文                                 |
| ------------------------- | ----------------------------------- | ------------------------------------------------------ |
| `ToolPart.metadata`       | 模型 tool call 的 provider metadata | 同 provider/model 时作为 `callProviderMetadata` 进入。 |
| `ToolPart.state.metadata` | 工具执行返回 metadata               | 默认不进入，主要给 UI/内部逻辑使用。                   |

### 4.5 Tool result 哪些字段进入上下文

`MessageV2.toModelMessages` 在 `../opencode/packages/opencode/src/session/message-v2.ts:715-766` 决定 tool result 进入上下文的结构。

completed tool 会变成：

```ts
{
  type: `tool-${part.tool}`,
  state: "output-available",
  toolCallId: part.callID,
  input: part.state.input,
  output: part.state.output 或 { text, attachments },
  callProviderMetadata?: part.metadata,
}
```

error tool 会变成：

```ts
{
  type: `tool-${part.tool}`,
  state: "output-error",
  toolCallId: part.callID,
  input: part.state.input,
  errorText: part.state.error,
  callProviderMetadata?: part.metadata,
}
```

pending/running tool 会被转成 synthetic error：

```ts
{
  type: `tool-${part.tool}`,
  state: "output-error",
  toolCallId: part.callID,
  input: part.state.input,
  errorText: "[Tool execution was interrupted]",
  callProviderMetadata?: part.metadata,
}
```

进入上下文的字段：

| 字段                   | 说明                                                     |
| ---------------------- | -------------------------------------------------------- |
| tool 名称              | 通过 `type: tool-${toolName}` 体现。                     |
| `toolCallId`           | 用于维持 tool call/result 配对。                         |
| `input`                | 模型当时调用工具的参数。                                 |
| `output`               | 工具返回文本，或者 text+attachments。                    |
| `errorText`            | 工具错误文本。                                           |
| `callProviderMetadata` | 同 provider/model 时保留的 tool call provider metadata。 |
| `attachments`          | image/pdf 等可作为 media 进入，具体取决于模型能力。      |

不直接进入上下文的字段：

| 字段                          | 说明                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `state.title`                 | UI 展示标题，不参与 `toModelMessages`。                                        |
| `state.metadata`              | 工具执行 metadata，不参与 `toModelMessages`，除非工具自己把内容写入 `output`。 |
| `state.time.start/end`        | 不进入。                                                                       |
| `part.id/messageID/sessionID` | DB/runtime 标识，不进入。                                                      |
| `step-finish` tokens/cost     | 不作为模型消息进入。                                                           |

### 4.6 Attachments 和 media 的进入规则

`MessageV2.toModelMessages` 在 `../opencode/packages/opencode/src/session/message-v2.ts:592-602` 判断模型是否支持 tool result media。

支持 tool result media 的 provider 包括 Anthropic、OpenAI、Amazon Bedrock、Google Vertex Anthropic，以及部分 Gemini 3。

规则：

| 情况                                     | 处理                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 支持 tool result media                   | `output` 变成 `{ text, attachments }`，由 `toModelOutput` 转成 text+media content。            |
| 不支持 tool result media                 | media attachments 被抽出来，额外注入一个 user message：`Attached image(s) from tool result:`。 |
| `stripMedia` 或 tool result 已 compacted | attachments 不进入上下文。                                                                     |

### 4.7 常见工具输出如何进入上下文

工具共同规则：`output` 默认进入上下文；`metadata` 默认不进入；`attachments` 可能进入。

| 工具                     | output 内容                                                                         | metadata 用途                           | 上下文影响                                                             |
| ------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| `read`                   | XML-like `<path>/<type>/<content>`，文本带行号；image/pdf 返回成功文本和 attachment | preview、truncated、loaded instructions | 文件内容直接进入；局部 AGENTS 可追加到 output 的 `<system-reminder>`。 |
| `grep`                   | matches 列表、行号、截断提示                                                        | matches、truncated                      | 搜索结果文本进入。                                                     |
| `glob`                   | 匹配文件路径列表                                                                    | count、truncated                        | 路径列表进入。                                                         |
| `bash`                   | stdout/stderr 合并输出，可能带 timeout metadata 文本                                | exit、description、preview              | 命令输出进入；exit code 本身不直接进入，除非写入 output。              |
| `edit/write/apply_patch` | 成功消息和 LSP diagnostics 文本                                                     | diff、filediff、diagnostics、files      | diff metadata 不直接进入；diagnostics 如果拼进 output 则进入。         |
| `task`                   | `task_id` 和 `<task_result>` 中子 agent 最后一段文本                                | sessionId、model                        | 父上下文只拿到最终文本和 task_id，子 session 历史不自动并入父上下文。  |
| `todowrite`              | todos JSON pretty print                                                             | todos                                   | 当轮 tool output 进入历史；Todo table 不自动每轮注入。                 |
| `skill`                  | `<skill_content>`，含完整 skill content、base dir、sampled files                    | name、dir                               | 完整 skill 内容进入，且 prune 保护。                                   |
| `webfetch`               | fetched markdown/text/html；image 为 attachment                                     | 空或少量 metadata                       | 文本或图片 attachment 进入。                                           |
| `codesearch`             | 外部 Exa 返回的 code context text                                                   | 空                                      | 外部检索结果进入，但不是本地 RAG。                                     |
| MCP tools                | MCP text/resource text join 后进入 output；image/blob 进 attachment                 | MCP result metadata 和 truncation       | 文本和 attachments 进入；MCP metadata 不直接进入。                     |

关键引用：`read.ts:21-235`、`skill.ts:81-102`、`todo.ts:19-29`、`task.ts:130-163`、`codesearch.ts:64-121`。

### 4.8 Tool output truncation 和 prune

普通工具输出如果太大，会由 `Tool.define` 统一调用 `Truncate.output`。从 subagent 研究和源码可见默认限制是约 2000 行或 50KB，完整输出会保存到 truncation 目录并在 output 里提示可读外部文件。这个完整文件不会自动进入上下文。

compaction prune 是另一层，发生在每轮结束后，逻辑在 `../opencode/packages/opencode/src/session/compaction.ts:91-139`。

prune 算法：

| 常量                    | 值            | 作用                                       |
| ----------------------- | ------------- | ------------------------------------------ |
| `PRUNE_PROTECT`         | 40,000 tokens | 最近约 40k tool output token 受保护。      |
| `PRUNE_MINIMUM`         | 20,000 tokens | 待 prune 总量超过该值才写 compacted 标记。 |
| `PRUNE_PROTECTED_TOOLS` | `skill`       | skill tool output 不被 prune。             |

流程：

```text
从最新消息往旧消息扫描
  -> 至少跨过最近 2 个 user turns 后才考虑 prune
  -> 遇到 assistant summary 停止
  -> 只处理 completed tool
  -> skill tool 跳过
  -> 累计 tool output token
  -> 超过 40k 后的旧 tool output 加入待 prune
  -> 如果待 prune token > 20k，给这些 ToolPart 设置 state.time.compacted
```

被 prune 后，`toModelMessages` 会把 output 替换为：

```text
[Old tool result content cleared]
```

同时 attachments 清空。相关转换在 `../opencode/packages/opencode/src/session/message-v2.ts:717-720`。

## 5. 上下文总体结构

每轮进入模型的上下文大体是：

```text
system messages:
  provider/agent core prompt
  environment block
  available skills block
  AGENTS.md / CLAUDE.md / CONTEXT.md / configured instruction URLs
  optional user message system prompt
  optional structured output system prompt

conversation messages:
  compacted boundary后的 MessageV2 history
  user text/file parts
  assistant text/reasoning parts
  assistant tool call/result parts
  tool media fallback user messages
  synthetic reminders
  compaction summary if session has compacted
  latest user request or synthetic continue/replay message

tools:
  Record<string, AI SDK Tool>
  activeTools after permission/user/tool visibility filtering
```

主 loop 的上下文构造在 `../opencode/packages/opencode/src/session/prompt.ts:1352-1572`。

## 6. 上下文管理

### 6.1 session history 读取和 compaction boundary

每轮读取历史：

```ts
MessageV2.filterCompacted(MessageV2.stream(sessionID));
```

调用位置：`../opencode/packages/opencode/src/session/prompt.ts:1363`。

`MessageV2.stream` 从 SQLite 分页读取 message，并从新到旧 yield，定义在 `../opencode/packages/opencode/src/session/message-v2.ts:856-868`。

`filterCompacted` 定义在 `../opencode/packages/opencode/src/session/message-v2.ts:906-922`。算法是：

```text
从最新消息往旧消息读取
  -> result.push(msg)
  -> 如果遇到成功完成的 assistant summary，记录它的 parentID
  -> 如果再遇到 parentID 对应的 user compaction message，停止
  -> reverse(result)
```

结果是：成功 compaction 之前的旧历史不再进入普通模型上下文，只通过 compaction summary message 保留。

### 6.2 system prompt 来源

`SystemPrompt.environment(model)` 在 `../opencode/packages/opencode/src/session/system.ts:36-60` 生成环境块，包括模型名、cwd、workspace root、git repo 状态、platform、日期。

`SystemPrompt.skills(agent)` 在 `../opencode/packages/opencode/src/session/system.ts:63-75` 注入可用 skill 列表。它只注入 name/description/location，不注入 skill 全文。skill 全文必须由模型调用 `skill` tool 后进入。

`InstructionPrompt.system()` 在 `../opencode/packages/opencode/src/session/instruction.ts:117-142` 读取 instruction 文件和配置 URL，每轮作为 system prompt 注入。

### 6.3 AGENTS / CLAUDE / CONTEXT instructions

instruction 文件名在 `../opencode/packages/opencode/src/session/instruction.ts:14-18`：

```text
AGENTS.md
CLAUDE.md
CONTEXT.md
```

system instruction 加载规则在 `../opencode/packages/opencode/src/session/instruction.ts:72-142`：

| 来源                | 算法                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| project instruction | 从 `Instance.directory` 向上到 worktree 查找，按 `AGENTS.md`、`CLAUDE.md`、`CONTEXT.md` 顺序，找到某类后 break。 |
| global instruction  | `OPENCODE_CONFIG_DIR/AGENTS.md`、opencode config `AGENTS.md`、`~/.claude/CLAUDE.md`，存在则加入，找到后 break。  |
| config instructions | 支持本地 glob/path 和 URL；URL 用 5s timeout fetch。                                                             |

局部 instruction 动态注入在 `../opencode/packages/opencode/src/session/instruction.ts:168-190` 和 `../opencode/packages/opencode/src/tool/read.ts:121-224`：

```text
read(file) 时
  -> 从文件目录向上查 AGENTS/CLAUDE/CONTEXT
  -> 排除目标文件自身
  -> 排除 system instruction path
  -> 排除历史 read metadata.loaded 已加载的 path
  -> 排除当前 messageID 已 claim 的 path
  -> 读取内容
  -> 追加到 read output 的 <system-reminder>
```

因此 AGENTS 类文件有两种进入上下文方式：

| 方式                          | 上下文位置                              | 生命周期                                     |
| ----------------------------- | --------------------------------------- | -------------------------------------------- |
| system instruction            | 每轮 system prompt                      | 长期配置型上下文。                           |
| read 时发现的局部 instruction | read tool output 的 `<system-reminder>` | 普通短期历史，可能被 prune/compaction 影响。 |

### 6.4 file context

文件内容不会自动做全项目索引进入上下文，必须通过显式 read/file/tool result 进入。

`read` 工具输出格式在 `../opencode/packages/opencode/src/tool/read.ts:99-234`：

```xml
<path>/abs/path</path>
<type>file</type>
<content>
1: line...
2: line...

(End of file - total N lines)
</content>
```

默认读取限制：

| 限制                   | 值           |
| ---------------------- | ------------ |
| 默认行数               | 2000 lines   |
| 单行最大               | 2000 chars   |
| 总输出最大             | 50KB         |
| directory 默认 entries | 2000 entries |

用户 prompt 中的 file part 也会被处理。根据 subagent 调研，`SessionPrompt.createUserMessage` 会把 `text/plain` file 和 directory 通过 `ReadTool` 转成 synthetic text part；非文本文件作为 base64 data URL file part 注入。

`FileTime` 记录文件读时间戳，用于写前一致性校验，不作为模型上下文。它是 per-session 进程内状态，不是长期记忆。

### 6.5 自动 compaction

overflow 判断在 `../opencode/packages/opencode/src/session/overflow.ts:8-22`。

算法：

```ts
if (cfg.compaction?.auto === false) return false;
if (model.limit.context === 0) return false;

count = tokens.total ?? input + output + cache.read + cache.write;
reserved = cfg.compaction?.reserved ?? min(20_000, maxOutputTokens(model));
usable = model.limit.input
  ? model.limit.input - reserved
  : contextLimit - maxOutputTokens(model);

return count >= usable;
```

触发点：

| 触发                                                          | 代码                                           |
| ------------------------------------------------------------- | ---------------------------------------------- |
| 主 loop 检测上一轮 assistant usage overflow                   | `prompt.ts:1418-1425`                          |
| processor finish-step 后检测 overflow 并返回 compact          | `processor.ts:301-306`                         |
| 模型/provider 报 context overflow，processor 可能转为 compact | `message-v2.ts:979-987`, `prompt.ts:1549-1558` |

compaction 创建一个 user message 和 `compaction` part，见 `../opencode/packages/opencode/src/session/compaction.ts:348-371`。

compaction 执行在 `../opencode/packages/opencode/src/session/compaction.ts:141-346`：

```text
找到 compaction parent user message
  -> 如果 overflow，可能把上一条真实 user message作为 replay，summary 只覆盖更早历史
  -> 使用 compaction agent
  -> 构造默认 summary prompt
  -> MessageV2.toModelMessages(messages, model, { stripMedia: true })
  -> 追加 user prompt：Provide a detailed prompt for continuing...
  -> tools = {}
  -> 生成 assistant summary message，summary: true
  -> 自动 compaction 成功后，创建 replay user message 或 synthetic continue user message
```

默认 summary prompt 要求输出 continuation prompt，包含 Goal、Instructions、Discoveries、Accomplished、Relevant files。它是 opencode 的短期记忆压缩核心。

### 6.6 reminders 和多步消息

`insertReminders` 在主 loop 中调用，位置是 `../opencode/packages/opencode/src/session/prompt.ts:1437`。它会根据 agent/session 模式插入 synthetic reminders，例如 plan/build 相关提醒。

如果 step > 1 且用户在中途又发了新文本，`prompt.ts:1487-1503` 会把这些新文本包装成：

```xml
<system-reminder>
The user sent the following message:
...

Please address this message and continue with your tasks.
</system-reminder>
```

这类 reminder 是短期上下文的一部分，会随着 messages 转换进入模型。

## 7. 记忆机制

### 7.1 短期记忆

opencode 的短期记忆就是当前 session 可恢复的消息事实流，以及从中派生出的 compacted history。

短期记忆来源：

| 来源                  | 记录位置                           | 进入上下文算法                                             |
| --------------------- | ---------------------------------- | ---------------------------------------------------------- |
| 用户和 assistant 文本 | SQLite `message`/`part`            | `MessageV2.stream -> filterCompacted -> toModelMessages`。 |
| tool call/result      | SQLite `part.data` 中的 `ToolPart` | completed/error/running 按 tool result 规则转换。          |
| read 文件内容         | read tool output                   | 作为 tool output 进入，可能被 prune。                      |
| 文件附件              | user file part 或 tool attachments | file part 或 media tool result/fallback user message。     |
| loaded skill content  | skill tool output                  | 作为 tool output 进入，prune 保护。                        |
| subagent result       | task tool output                   | 父 session 只保存 `task_id` 和最后文本。                   |
| todo 状态             | `todowrite` output 和 `todo` table | output 进入上下文；Todo table 未发现自动注入。             |
| compaction summary    | assistant message `summary: true`  | filterCompacted 后保留为旧历史摘要。                       |
| local instructions    | read output system-reminder        | 作为 read output 的一部分进入。                            |

短期记忆保留算法：

```text
普通情况：保留整个 session history
tool output 太大：先截断 output，完整内容外部保存但不自动进入
每轮结束：prune 旧 tool output，skill 例外
context overflow：生成 compaction summary
成功 compaction 后：只保留 summary 之后的历史
```

### 7.2 长期记忆

没有发现类似“自动记录用户偏好、跨 session 自动召回、embedding 召回”的长期记忆系统。

可以被误认为长期记忆的组件：

| 组件                  | 实际性质                            | 是否自动跨 session 召回 learned memory             |
| --------------------- | ----------------------------------- | -------------------------------------------------- |
| AGENTS/CLAUDE/CONTEXT | 文件型配置 instruction              | 是配置注入，不是 learned memory。                  |
| global AGENTS         | 全局配置 instruction                | 是配置注入，不是 learned memory。                  |
| skills                | 文件/URL 发现的能力包               | 只注入列表；全文需显式 tool 调用。                 |
| SQLite sessions       | 会话持久化                          | 只对同 session 恢复；没有发现跨 session 检索召回。 |
| child task sessions   | 子任务会话持久化                    | 需要显式 `task_id` resume，不自动召回。            |
| Todo table            | session 任务状态                    | 供 UI/API；主 loop 未发现自动读取注入。            |
| session summary diff  | diff/addition/deletion/files 元数据 | 用于 UI/status/revert，不是 prompt memory。        |

判断：opencode 目前的长期“记忆”更准确叫长期配置上下文和持久会话记录，不是 autonomous long-term memory。

### 7.3 Todo 不是自动上下文记忆

Todo schema 和持久化在 `../opencode/packages/opencode/src/session/todo.ts` 与 `session.sql.ts:78-95`。

`todowrite` 工具执行在 `../opencode/packages/opencode/src/tool/todo.ts:19-29`：写 Todo table，并返回 todos JSON 作为 output。

代码检索只发现 `Todo.get` 定义，没有发现主 loop 每轮自动读取 Todo table 注入 prompt。因此：

| 位置                    | 是否进入模型               |
| ----------------------- | -------------------------- |
| `todowrite` tool output | 是，作为普通 tool result。 |
| Todo table 最新状态     | 未发现自动进入。           |

### 7.4 Task/subagent 是显式可恢复短期记忆

`task` 工具在 `../opencode/packages/opencode/src/tool/task.ts:69-163` 创建或恢复 child session。

规则：

| 行为                | 说明                                                               |
| ------------------- | ------------------------------------------------------------------ |
| 无 `task_id`        | 创建 `parentID = 当前 session` 的 child session。                  |
| 有 `task_id` 且存在 | 复用该 child session。                                             |
| 子任务执行          | 调用 `SessionPrompt.prompt` 在 child session 内跑完整 agent loop。 |
| 返回父上下文        | 只返回 `task_id` 和 child session 最后 text part。                 |

因此 task 是显式 session-level memory extension，不是自动长期记忆。

### 7.5 Skill 是长期配置资源，全文加载后成为短期上下文

skill 发现和加载在 `../opencode/packages/opencode/src/skill/index.ts:137-258`。

来源：

| 来源                  | 规则                                                             |
| --------------------- | ---------------------------------------------------------------- |
| global external       | `~/.claude/skills/**/SKILL.md`、`~/.agents/skills/**/SKILL.md`。 |
| project external      | 从当前目录向上查 `.claude`、`.agents` 下的 skills。              |
| opencode config dirs  | `{skill,skills}/**/SKILL.md`。                                   |
| config `skills.paths` | 扫描指定目录。                                                   |
| config `skills.urls`  | discovery pull 后扫描。                                          |

进入上下文的两层：

| 层         | 进入方式                          | 内容                                                              |
| ---------- | --------------------------------- | ----------------------------------------------------------------- |
| skill 列表 | 每轮 `SystemPrompt.skills(agent)` | name、description、location。                                     |
| skill 全文 | 模型调用 `skill` tool             | `<skill_content>`，含 markdown content、base dir、sampled files。 |

`skill` tool output 受 prune 保护，但仍然受 session compaction boundary 影响。即如果它在成功 compaction 边界之前，旧消息不再进入普通上下文，除非 summary 中保留了相关信息。

## 8. RAG / embedding / 检索

结论：未发现 opencode 本地实现 embedding/RAG。

证据：

| 检索                                 | 结果                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `embedding`, `embed`, `vector_store` | 仅 provider SDK 协议字段和注释，例如 OpenAI Responses file search 的 `vector_store_ids`。 |
| 本地索引/chunking/vector DB          | 未发现。                                                                                  |
| 自动语义召回 pipeline                | 未发现。                                                                                  |

实际存在的检索机制：

| 机制                         | 类型                                                    | 是否 RAG                                    |
| ---------------------------- | ------------------------------------------------------- | ------------------------------------------- |
| `grep`                       | ripgrep 关键词/正则搜索                                 | 否。                                        |
| `glob`                       | 文件名 pattern 搜索                                     | 否。                                        |
| `read`                       | 显式文件读取                                            | 否。                                        |
| `codesearch`                 | 调用 `https://mcp.exa.ai/mcp` 的 `get_code_context_exa` | 外部检索工具，不是本地 RAG。                |
| MCP resources/tools          | 外部 tool/resource 读取                                 | 取决于 MCP server，本仓库不维护 RAG state。 |
| provider vector store fields | provider 协议支持                                       | 不代表 opencode 实现本地 RAG。              |

`codesearch` 代码在 `../opencode/packages/opencode/src/tool/codesearch.ts:36-132`。它构造 JSON-RPC `tools/call` 请求，请求外部 Exa MCP endpoint，然后把返回 text 当作 tool output 进入上下文。

## 9. 与“上下文会看到什么”相关的精确判断

### 9.1 模型会看到的内容

模型通常会看到：

| 内容                        | 来源                                                  |
| --------------------------- | ----------------------------------------------------- |
| core provider/agent prompt  | `LLM.stream` 合成 system。                            |
| 环境信息                    | `SystemPrompt.environment`。                          |
| skill 列表                  | `SystemPrompt.skills`。                               |
| AGENTS/CLAUDE/CONTEXT       | `InstructionPrompt.system` 或 read output reminder。  |
| 用户文本                    | `TextPart`。                                          |
| 非文本附件                  | `FilePart` 或 media fallback user message。           |
| assistant 文本/reasoning    | `TextPart`、`ReasoningPart`。                         |
| completed tool input/output | `ToolPart.state.input/output`。                       |
| tool error                  | `ToolPart.state.error`。                              |
| pruned old tool result 占位 | `[Old tool result content cleared]`。                 |
| compaction summary          | assistant summary message。                           |
| synthetic reminders         | multi-step continuation/user-interruption reminders。 |

### 9.2 模型默认看不到的内容

模型默认看不到：

| 内容                        | 说明                                                                   |
| --------------------------- | ---------------------------------------------------------------------- |
| tool result metadata        | 如 grep count、edit diff、bash exit、read preview，除非被写入 output。 |
| tool title                  | UI 用。                                                                |
| tool start/end time         | 运行时/历史元数据。                                                    |
| step snapshots/patch part   | 用于 diff/revert/status，不转成 model messages。                       |
| session summary diff        | UI/status/revert 元数据。                                              |
| Todo table 最新状态         | 未发现自动注入。                                                       |
| truncation full output 文件 | 需要模型后续显式 read/grep 对应路径。                                  |
| FileTime 状态               | 只用于写前一致性校验。                                                 |
| child session 全量历史      | 父 session 只得到 task output；除非显式 resume child session。         |

## 10. 对本项目实现的参考

如果要在当前 `OpenCode-Web-Lite-MVP` 中借鉴 opencode 的设计，最值得复用的抽象是：

| 方向          | 建议                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| 内部消息格式  | 不要直接持久化 provider-native messages，先定义自己的 `Message + Part` schema。                           |
| tool result   | 区分 model-visible `output/attachments/input/error` 和 UI-only `metadata/title/time`。                    |
| context build | 每轮从持久化 history 重新构建 `ModelMessage[]`，而不是维护易漂移的内存数组。                              |
| compaction    | 用 assistant summary 作为短期记忆压缩边界，并让历史过滤算法只保留 summary 后的 tail。                     |
| prune         | 单独清理旧 tool output，不删除原始 message，只设置 compacted 标记并输出占位。                             |
| memory        | 先把 AGENTS/skills/todo/session summary 分清楚：配置上下文、会话短期记忆、UI 状态、长期记忆不要混在一起。 |
| RAG           | 如果需要本地 RAG，需要额外设计 embedding/index/retrieval；opencode 当前代码不能直接提供这层。             |

## 11. 最小复刻结构

一个接近 opencode 的最小 agent runtime 上下文结构可以是：

```ts
type Message = {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  createdAt: number;
  model?: { providerID: string; modelID: string };
  agent?: string;
  summary?: boolean;
  tokens?: TokenUsage;
  finish?: string;
};

type Part =
  | { type: 'text'; text: string; ignored?: boolean; synthetic?: boolean }
  | { type: 'file'; mime: string; url: string; filename?: string }
  | {
      type: 'tool';
      callID: string;
      tool: string;
      state: ToolState;
      providerMetadata?: unknown;
    }
  | { type: 'reasoning'; text: string }
  | { type: 'compaction'; auto: boolean; overflow?: boolean };

type ToolState =
  | { status: 'pending'; input: Record<string, unknown>; raw: string }
  | { status: 'running'; input: Record<string, unknown>; startedAt: number }
  | {
      status: 'completed';
      input: Record<string, unknown>;
      output: string;
      metadata: Record<string, unknown>;
      title: string;
      startedAt: number;
      endedAt: number;
      compactedAt?: number;
      attachments?: FilePart[];
    }
  | { status: 'error'; input: Record<string, unknown>; error: string };

type InternalLLMRequest = {
  sessionID: string;
  user: Message;
  agent: AgentInfo;
  model: ModelInfo;
  system: string[];
  messages: ModelMessage[];
  tools: Record<string, Tool>;
  toolChoice?: 'auto' | 'required' | 'none';
};
```

关键是把“持久化事实结构”和“模型调用结构”分离，并明确 tool result 的哪些字段是 model-visible。
