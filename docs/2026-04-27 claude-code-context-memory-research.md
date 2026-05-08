# Claude Code 上下文、工具和记忆机制研究

研究对象：`../claude-code`。

研究重点：tools、tool result 进入上下文的路径、上下文构建和压缩、长期记忆、短期记忆，以及是否存在 RAG/embedding 检索。

结论摘要：Claude Code 的上下文系统不是单一 `ContextManager` 类，而是一条分层 pipeline。核心是 `Message[]` 作为内部事实流，进入模型前经过 tool result budget、snip、microcompact、context collapse、auto-compact、message normalization、tool schema filtering、system prompt block 构建。长期记忆主要是文件型 memory 和 markdown instruction；短期记忆主要是 session summary/compaction；没有发现传统 embedding/vector DB RAG，替代机制是 `MEMORY.md` 索引、frontmatter manifest、LLM selector、grep/read、attachments 注入。

## 1. 总体模型

Claude Code 的模型请求最终是 Anthropic Messages API 风格：

```ts
{
  model,
  system,
  messages,
  tools,
  tool_choice,
  betas?,
  metadata,
  max_tokens,
  thinking?,
  temperature?,
  context_management?,
  output_config?,
  speed?,
}
```

关键构建点：

| 层                | 负责内容                                                         | 核心文件                                                                |
| ----------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| query loop        | 当前消息视图、compact、tool 执行、递归 follow-up                 | `src/query.ts`                                                          |
| API layer         | message normalize、tool schema、system blocks、payload           | `src/services/api/claude.ts`                                            |
| message normalize | 过滤 UI-only/system/progress、合并 user/tool results、修复 shape | `src/utils/messages.ts`                                                 |
| tool execution    | permission、hooks、call、tool_result block                       | `src/services/tools/toolExecution.ts`                                   |
| compaction        | full/partial/session-memory compaction                           | `src/services/compact/*`                                                |
| memory            | CLAUDE.md、auto-memory、session-memory、skills                   | `src/utils/claudemd.ts`, `src/memdir/*`, `src/services/SessionMemory/*` |

模型最终看到的大体结构：

```text
top-level system:
  attribution / CLI prefix / core system prompt / memory behavior prompt / dynamic system context

top-level tools:
  available tool schemas, possibly deferred by ToolSearch

messages:
  compact summary user message, if compacted
  preserved recent messages, if any
  memory / skill / file attachments as meta user messages
  real user messages
  assistant messages, including thinking/text/tool_use blocks
  user tool_result messages
```

重要源码引用：

| 内容                                                                                                        | 引用                                   |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| query loop 先截 compact boundary，再 tool result budget、snip、microcompact、context collapse、auto-compact | `src/query.ts:365-535`                 |
| query loop 调模型时传入 `prependUserContext(messagesForQuery, userContext)` 和 `fullSystemPrompt`           | `src/query.ts:659-708`                 |
| API 层 normalize messages、repair tool pairing、strip media、构建 system blocks                             | `src/services/api/claude.ts:1259-1379` |
| 最终 request params                                                                                         | `src/services/api/claude.ts:1699-1728` |

## 2. Tools 体系

### 2.1 Tool 接口

`Tool` 是高度结构化的运行时对象，既包含模型可见 schema，也包含 UI、权限、并发、安全和 result mapping 行为。

核心类型在 `src/Tool.ts`。

`ToolResult<T>`：

```ts
export type ToolResult<T> = {
  data: T;
  newMessages?: (
    | UserMessage
    | AssistantMessage
    | AttachmentMessage
    | SystemMessage
  )[];
  contextModifier?: (context: ToolUseContext) => ToolUseContext;
  mcpMeta?: {
    _meta?: Record<string, unknown>;
    structuredContent?: Record<string, unknown>;
  };
};
```

关键字段：

| 字段                      | 是否直接进模型上下文 | 说明                                                                     |
| ------------------------- | -------------------- | ------------------------------------------------------------------------ |
| `data`                    | 间接进入             | 通过 `mapToolResultToToolResultBlockParam()` 转成 `tool_result.content`  |
| `newMessages`             | 可能进入             | 如果是 user/assistant/attachment/system-local，后续 normalize 后可能进入 |
| `contextModifier`         | 不直接进入           | 修改 runtime context，例如 readFileState 等                              |
| `mcpMeta`                 | 不直接进入           | 注释说明用于 SDK consumers pass-through，不发给模型                      |
| `renderToolResultMessage` | 不进入               | UI/transcript rendering，不是 model-facing serialization                 |
| `toolUseResult`           | 不直接进入           | 存在于 internal `UserMessage` 顶层，用于 UI/SDK，不是 API content        |

关键引用：

| 内容                                                                                    | 引用                  |
| --------------------------------------------------------------------------------------- | --------------------- |
| `ToolResult<T>` 定义                                                                    | `src/Tool.ts:321-336` |
| `Tool` 关键方法，包括 `call`, `checkPermissions`, `mapToolResultToToolResultBlockParam` | `src/Tool.ts:379-560` |
| UI rendering 与 model-facing serialization 区分                                         | `src/Tool.ts:557-588` |

### 2.2 Tool 注册和可见性

Claude Code 有一个基础工具池，然后按模式、权限、feature gate、MCP、ToolSearch 动态过滤。

主要文件：`src/tools.ts`。

工具来源：

| 来源           | 说明                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| base tools     | Bash、Read、Edit、Write、Grep、Glob、Todo、Agent、WebFetch、WebSearch 等 |
| MCP tools      | 与 base tools 合并，受 deny rules 影响                                   |
| special tools  | 一些工具不直接暴露给模型，或仅特定模式暴露                               |
| deferred tools | ToolSearch 启用后，部分工具只以 `defer_loading` 形式进入 API             |

重要机制：

| 机制                          | 作用                                                             |
| ----------------------------- | ---------------------------------------------------------------- |
| `getAllBaseTools()`           | 构造基础工具列表，带大量 feature gate                            |
| `getTools(permissionContext)` | 根据权限、simple mode、REPL mode、deny rules、`isEnabled()` 过滤 |
| `assembleToolPool()`          | 合并 base tools 和 MCP tools，排序并去重                         |
| `toolToAPISchema()`           | 将内部 Tool 转为 API tool schema                                 |
| ToolSearch                    | MCP/大工具集场景下延迟加载工具 schema                            |

关键引用：

| 内容                                                     | 引用                              |
| -------------------------------------------------------- | --------------------------------- |
| base tools 注册                                          | `src/tools.ts:193-250`            |
| deny rules 过滤工具                                      | `src/tools.ts:262-327`            |
| base + MCP 合并                                          | `src/tools.ts:345-367`            |
| Tool -> API schema                                       | `src/utils/api.ts:119-265`        |
| ToolSearch discovered tools 从历史 `tool_reference` 提取 | `src/utils/toolSearch.ts:524-592` |

## 3. Tool Result 如何进入上下文

### 3.1 执行链路

执行链路是：

```text
assistant tool_use block
  -> query.ts 收集 toolUseBlocks
  -> runTools(...)
  -> runToolUse(...)
  -> input schema validation
  -> PreToolUse hooks
  -> permission decision
  -> tool.call(...)
  -> mapToolResultToToolResultBlockParam(...)
  -> processToolResultBlock / processPreMappedToolResultBlock
  -> createUserMessage({ content: [tool_result block], toolUseResult, mcpMeta })
  -> normalizeMessagesForAPI(...)
  -> 下一轮 messages 中的 user tool_result
```

query loop 中工具结果会先作为 internal message yield 给 UI/transcript，然后 normalize 成 API user message，加入下一轮 follow-up：

```ts
toolResults.push(
  ...normalizeMessagesForAPI(
    [update.message],
    toolUseContext.options.tools
  ).filter((_) => _.type === 'user')
);
```

关键引用：

| 内容                                            | 引用                                             |
| ----------------------------------------------- | ------------------------------------------------ |
| 收集 tool calls                                 | `src/query.ts:826-845`                           |
| toolUpdates 执行和 normalize 后进入 toolResults | `src/query.ts:1380-1400`                         |
| `runTools` 调度串行/并发                        | `src/services/tools/toolOrchestration.ts:19-177` |
| 单工具执行、validation、permission、tool.call   | `src/services/tools/toolExecution.ts:337-1295`   |

主链路

1. query() 在每轮开始维护 assistantMessages 和 toolResults 两个数组，claude-code/src/query.ts:551。模型流式吐出 tool_use 后，后处理阶段调用
   runTools(...)，claude-code/src/query.ts:1380。
2. runTools() 只是编排层，按并发安全性分批，然后逐个/并发调用 runToolUse()，claude-code/src/services/tools/toolOrchestration.ts:19。
3. runToolUse() 先做工具查找。找不到工具、被中断、或者抛异常时，都会直接构造一个 user 消息，其 content 里放 tool_result，并带上 tool_use_id 和 is_error，
   claude-code/src/services/tools/toolExecution.ts:337、claude-code/src/services/tools/toolExecution.ts:396、claude-code/src/services/tools/
   toolExecution.ts:1715。
4. 真正执行前会进 checkPermissionsAndCallTool()。这里先做 inputSchema.safeParse() 和 validateInput()；如果失败，返回的仍然是 user tool_result，而不是普通
   文本，claude-code/src/services/tools/toolExecution.ts:599。权限拒绝也是同样模式：构造 is_error: true 的 tool_result 进入后续上下文，claude-code/src/
   services/tools/toolExecution.ts:1023。
5. 只有通过这些检查后，才会真正 await tool.call(...)，claude-code/src/services/tools/toolExecution.ts:1207。tool.call() 返回的是 ToolResult<T>，其中原始输
   出在 result.data，旁路元数据在 mcpMeta，claude-code/src/Tool.ts:332。
6. result.data 不会自动进 prompt。它必须先经过每个工具自己的 mapToolResultToToolResultBlockParam(result.data, toolUseID)，变成模型能看的
   ToolResultBlockParam，claude-code/src/Tool.ts:557、claude-code/src/services/tools/toolExecution.ts:1290。
7. mapper 之后还要过一层 processPreMappedToolResultBlock() / processToolResultBlock()。这一层会做“大结果落盘+给模型预览替代”的处理，所以进入上下文的内容可
   能已经不是原始全量输出了，claude-code/src/utils/toolResultStorage.ts:205。
8. 然后 addToolResult() 用这个 block 构造 createUserMessage({ content: [tool_result, ...], toolUseResult, mcpMeta })，claude-code/src/services/tools/
   toolExecution.ts:1403。这里的关键是：
   message.content 才是模型可见通道。
   toolUseResult 只是把原始 result.data 挂在消息对象上。
   mcpMeta 也是挂载给外部消费者，不是 prompt 内容，claude-code/src/utils/messages.ts:481。
9. 回到 query.ts，每个 update.message 会先 yield 到 transcript，然后立刻过一次 normalizeMessagesForAPI([update.message])，把可发给模型的 user 消息塞进
   toolResults，claude-code/src/query.ts:1384。
10. 本轮结束准备递归下一轮时，toolResults 会被直接拼进新的 state.messages：[...messagesForQuery, ...assistantMessages, ...toolResults]，claude-code/src/
    query.ts:1714。
11. 下一轮开始，messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]，这里的 messages 已经包含上一步的 user tool_result 了，claude-code/src/

UserMessage.toolUseResult
UserMessage.mcpMeta
UserMessage.sourceToolAssistantUUID

### 3.2 进入上下文的 tool result 结构

模型看到的是 Anthropic `tool_result` block：

```ts
{
  type: 'tool_result',
  tool_use_id: string,
  content?: string | ContentBlockParam[],
  is_error?: boolean,
}
```

该 block 被包在 `role: 'user'` 的 message 中。创建位置：

```ts
const contentBlocks: ContentBlockParam[] = [toolResultBlock];

createUserMessage({
  content: contentBlocks,
  imagePasteIds,
  toolUseResult,
  mcpMeta,
  sourceToolAssistantUUID: assistantMessage.uuid
});
```

关键引用：`src/services/tools/toolExecution.ts:1403-1473`。

进入模型的内容：

| 字段/内容                              | 进入上下文吗 | 说明                             |
| -------------------------------------- | ------------ | -------------------------------- |
| `tool_result.type`                     | 是           | API block type                   |
| `tool_result.tool_use_id`              | 是           | 与 assistant `tool_use.id` 配对  |
| `tool_result.content`                  | 是           | 由工具 mapper 决定的模型可见结果 |
| `tool_result.is_error`                 | 是           | 错误/拒绝/中断时为 true          |
| permission accept feedback             | 是           | 作为 sibling text block 追加     |
| permission 决策附带图片/content blocks | 是           | 作为 sibling blocks 追加         |
| `toolUseResult` 顶层字段               | 否           | UI/SDK/internal 使用             |
| `mcpMeta` 顶层字段                     | 否           | SDK consumers 使用               |
| `contextModifier`                      | 否           | 修改 runtime context             |
| progress messages                      | 否           | `normalizeMessagesForAPI` 过滤   |
| `renderToolResultMessage`              | 否           | 仅 UI/transcript rendering       |

### 3.3 mapper 决定 data 的哪些部分进入上下文

`tool.call()` 返回的 `result.data` 不会整体自动发送给模型。每个 tool 自己实现：

```ts
mapToolResultToToolResultBlockParam(content, toolUseID): ToolResultBlockParam
```

这意味着上下文中看到的是“工具选择暴露给模型的 projection”，不是完整内部结果。

例子：

| 工具 | 模型看到                                                                           | 不一定直接看到                            |
| ---- | ---------------------------------------------------------------------------------- | ----------------------------------------- |
| Bash | stdout/stderr、interrupt error、background info、persisted-output preview          | 完整 stdout 若超限、内部 timing、UI state |
| Read | 文件内容格式化文本、image block、PDF metadata、notebook cells、file unchanged stub | 文件读取内部对象的所有字段                |
| Grep | matching files/content/count summary                                               | 内部统计字段如 `numLines`                 |
| MCP  | MCP 返回 content；PostToolUse hook 可能改 output                                   | `_meta` / structured SDK metadata         |

关键引用：

| 内容                    | 引用                                             |
| ----------------------- | ------------------------------------------------ |
| Bash result mapping     | `src/tools/BashTool/BashTool.tsx:555-622`        |
| FileRead result mapping | `src/tools/FileReadTool/FileReadTool.ts:652-717` |
| Grep result mapping     | `src/tools/GrepTool/GrepTool.ts:254-309`         |
| MCP result mapping      | `src/tools/MCPTool/MCPTool.ts:70-76`             |

### 3.4 大结果和空结果处理

Claude Code 对 tool result 有两层压缩/替换。

第一层是单个 tool result 过大时持久化到磁盘：

```text
<persisted-output>
Output too large (...). Full output saved to: <path>

Preview (first ...):
...
</persisted-output>
```

模型看到的是路径和 preview，不是完整原始结果。

第二层是 message-level aggregate tool result budget，保证一条 user message 中多个 tool results 的总量不爆，并保持 replacement state 稳定以保护 prompt cache。

空 result 会被替换成：

```text
(<toolName> completed with no output)
```

原因是防止 prompt tail 的空 tool result 诱发模型采样 stop sequence。

关键引用：

| 内容                                    | 引用                                     |
| --------------------------------------- | ---------------------------------------- |
| large result persisted message          | `src/utils/toolResultStorage.ts:189-198` |
| process tool result block               | `src/utils/toolResultStorage.ts:205-242` |
| empty result replacement                | `src/utils/toolResultStorage.ts:245-295` |
| large result persistence                | `src/utils/toolResultStorage.ts:272-334` |
| aggregate budget state                  | `src/utils/toolResultStorage.ts:367-459` |
| query loop 调用 `applyToolResultBudget` | `src/query.ts:369-394`                   |

### 3.5 API normalize 对 tool results 的额外处理

`normalizeMessagesForAPI()` 负责让 internal messages 变成 API-safe messages。

与 tool result 相关的行为：

| 行为                   | 说明                                                   |
| ---------------------- | ------------------------------------------------------ |
| 过滤 `progress`        | UI-only 进度不进模型                                   |
| 过滤普通 `system`      | 只有 local command system message 转 user message      |
| 合并连续 user messages | Bedrock 不支持连续 user messages                       |
| `tool_reference` 过滤  | ToolSearch 关闭时剥离；开启时剥离不可用工具引用        |
| media strip            | PDF/image/request-too-large 后剥离对应 meta user block |
| pairing repair         | API 层插入 synthetic error 或移除 orphan tool_result   |

关键引用：

| 内容                                 | 引用                                   |
| ------------------------------------ | -------------------------------------- |
| `normalizeMessagesForAPI` 起始和过滤 | `src/utils/messages.ts:1989-2075`      |
| user message / tool_reference 处理   | `src/utils/messages.ts:2099-2185`      |
| assistant tool input normalize       | `src/utils/messages.ts:2201-2291`      |
| API 层 `ensureToolResultPairing`     | `src/services/api/claude.ts:1298-1302` |

## 4. 上下文管理 Pipeline

### 4.1 query loop 中的上下文处理顺序

每次进入模型前，`src/query.ts` 大致按这个顺序处理：

```text
messages
  -> getMessagesAfterCompactBoundary(messages)
  -> applyToolResultBudget(...)
  -> snipCompactIfNeeded(...), feature gated
  -> microcompactMessages(...)
  -> contextCollapse.applyCollapsesIfNeeded(...), feature gated
  -> appendSystemContext(systemPrompt, systemContext)
  -> autoCompactIfNeeded(...)
  -> if compacted: buildPostCompactMessages(...)
  -> prependUserContext(messagesForQuery, userContext)
  -> callModel(...)
```

这说明 Claude Code 的上下文管理不是“每种来源都打分排序”的 RAG pipeline，而是更工程化的多阶段裁剪/摘要/归一化 pipeline。

关键引用：`src/query.ts:365-535`。

每一步在干什么

1. getMessagesAfterCompactBoundary() 不是简单切片。
   它先找到最后一个 compact_boundary，只保留那之后的消息；如果开了 HISTORY_SNIP，还会默认再走一次 projectSnippedView()，把历史上已经 snip 掉的内容从
   model-facing 视图里投影掉。claude-code/src/utils/messages.ts:4631
2. applyToolResultBudget() 是“每条 user message 内 tool_result 总量预算”。
   如果某条 user message 里的多个 tool_result 总和超预算，就把其中最大的“新鲜结果”落盘并替换成 preview。重点是它按 tool_use_id 维护稳定 replacement
   state，已经见过的结果以后只会复用同样 replacement，不会下一轮突然改策略，目的是稳定 prompt cache。claude-code/src/utils/toolResultStorage.ts:740、
   claude-code/src/utils/toolResultStorage.ts:924
3. snipCompactIfNeeded() 的源码文件不在这份 checkout 里。
   但从调用契约能确认它返回 { messages, tokensFreed, boundaryMessage? }，并且 tokensFreed 会继续传给 autocompact，用来修正阈值判断，因为普通 token
   estimation 看不到 snip 对受保护尾部的影响。claude-code/src/query.ts:396
4. microcompactMessages() 主要处理“旧 tool result 缩减”，而且优先走时间型和 cache-editing 型路径。
   它先看“距离上次 assistant 太久导致 server cache 已冷”的 time-based trigger；命中就直接返回压缩结果。否则如果支持 cached microcompact，就不改本地
   messages，只登记 cache_edits 让 API 层去删缓存前缀里的 tool results。两种都不适用时它直接 no-op。claude-code/src/services/compact/microCompact.ts:253
5. contextCollapse.applyCollapsesIfNeeded() 是“投影视图”，不是简单改数组。
   这部分实现源码同样不在当前 checkout，但 query.ts 注释写得很清楚：它在 autocompact 之前先把 collapse 视图投影出来，必要时提交更多 collapse；它不 yield
   消息，summary 存在独立 store 里，因此 collapse 可以跨 turn 持久化。claude-code/src/query.ts:428
6. appendSystemContext() 不动消息历史，它只构造系统提示。
   它把原始 systemPrompt 数组后面追加一段 "key: value" 拼接文本，然后包成 fullSystemPrompt。claude-code/src/utils/api.ts:437
   这一步和 messagesForQuery 是两条线。
7. autoCompactIfNeeded() 才是真正“总结旧历史”的大刀。
   它先过环境开关和失败熔断，再判断是否该 compact；先尝试 session-memory compaction，再尝试传统 compactConversation()。这里传进去的不是 fullSystemPrompt，
   而是一组 cacheSafeParams，包括原始 systemPrompt、userContext、systemContext 和当前 forkContextMessages，说明 compact 过程会自己重建需要的 prompt 视图。
   claude-code/src/services/compact/autoCompact.ts:241、claude-code/src/query.ts:454
8. buildPostCompactMessages() 很直接：
   boundaryMarker + summaryMessages + messagesToKeep + attachments + hookResults。
   也就是说 compact 一旦成功，本轮后续 API 调用就不再拿原 messagesForQuery，而是拿这一套“边界+摘要+保留尾部”的新数组。claude-code/src/services/compact/
   compact.ts:330
9. prependUserContext() 是“最后一刻注入”的 head message。
   它把 userContext 变成一个 isMeta: true 的 user message，包在 <system-reminder> 里插到最前面；测试环境直接跳过。也就是说 userContext 默认不参与前面那些
   compact/snip/budget 处理，只在真正发请求时注入。claude-code/src/utils/api.ts:449
10. callModel() 不是终点，API 层还有一轮 last-mile 处理。
    query.ts 里调用的是 queryModelWithStreaming。claude-code/src/query/deps.ts:2
    它进来后会：

- normalizeMessagesForAPI(messages, filteredTools)
- 按模型能力剥掉 tool-search 专用字段
- ensureToolResultPairing() 修复 tool_use/tool_result 配对
- 去掉 advisor/media 等不合法内容
- 再把 UserMessage/AssistantMessage 转成真正的 MessageParam
  位置：claude-code/src/services/api/claude.ts:1259、claude-code/src/services/api/claude.ts:1298、claude-code/src/services/api/claude.ts:590

### 4.2 system prompt 和 user context

system prompt 由多个来源组成：

| 来源                                     | 注入位置                  |
| ---------------------------------------- | ------------------------- |
| attribution header                       | API 层 system prompt 前缀 |
| CLI sysprompt prefix                     | API 层 system prompt 前缀 |
| core system prompt                       | top-level `system`        |
| memory behavior prompt                   | system prompt section     |
| dynamic system context                   | `appendSystemContext`     |
| advisory/chrome/tool-search instructions | API 层条件追加            |

user context 通过 `prependUserContext(messagesForQuery, userContext)` 注入消息侧，典型包括 CLAUDE.md 内容、current date、cwd、git status、directory structure、memory files 等。

关键引用：

| 内容                                                              | 引用                                   |
| ----------------------------------------------------------------- | -------------------------------------- |
| query loop append system context                                  | `src/query.ts:449-451`                 |
| call model 使用 prepend user context                              | `src/query.ts:659-708`                 |
| API 层补 attribution / CLI prefix / advisor / chrome instructions | `src/services/api/claude.ts:1357-1379` |
| request params 中 `system` 与 `messages` 分离                     | `src/services/api/claude.ts:1699-1728` |

### 4.3 message normalize 的总体策略

内部 `Message[]` 类型比 API messages 丰富，可能包含：

```text
user
assistant
attachment
progress
system
compact boundary
synthetic API error
virtual messages
```

进入 API 前只保留 API 可接受的 user/assistant messages，并做结构修复。

保留/转换规则：

| 内部 message           | API 处理                                                       |
| ---------------------- | -------------------------------------------------------------- |
| `user`                 | 保留，可能合并和过滤 content blocks                            |
| `assistant`            | 保留，tool inputs normalize，可能合并 split assistant messages |
| `attachment`           | 转成 meta user message                                         |
| `system` local command | 转成 user message                                              |
| 普通 `system`          | 过滤                                                           |
| `progress`             | 过滤                                                           |
| virtual user/assistant | 过滤                                                           |
| synthetic API error    | 过滤，同时触发 media strip                                     |

关键引用：`src/utils/messages.ts:1989-2370`。

## 5. Compaction 和短期上下文压缩

### 5.1 Auto-compact 阈值

Auto-compact 不是等 context window 满了才触发。它先预留 summary 输出空间，然后再留 buffer。

```ts
effectiveContextWindow = contextWindow - min(maxOutputTokensForModel, 20_000);
autoCompactThreshold = effectiveContextWindow - 13_000;
```

其他阈值：

| 常量                              | 值       | 用途                                  |
| --------------------------------- | -------- | ------------------------------------- |
| `MAX_OUTPUT_TOKENS_FOR_SUMMARY`   | `20_000` | compaction summary 输出预留           |
| `AUTOCOMPACT_BUFFER_TOKENS`       | `13_000` | 自动压缩触发前 buffer                 |
| `WARNING_THRESHOLD_BUFFER_TOKENS` | `20_000` | UI warning                            |
| `ERROR_THRESHOLD_BUFFER_TOKENS`   | `20_000` | UI error                              |
| `MANUAL_COMPACT_BUFFER_TOKENS`    | `3_000`  | auto-compact off 时保留给手动 compact |

关键引用：`src/services/compact/autoCompact.ts:28-145`。

### 5.2 Auto-compact 决策

`shouldAutoCompact()` 的重要 guard：

| guard                                      | 说明                                       |
| ------------------------------------------ | ------------------------------------------ | ---------- | ---------------------------------- |
| `querySource === 'session_memory'          |                                            | 'compact'` | 防止 compaction agent 递归 compact |
| `DISABLE_COMPACT` / `DISABLE_AUTO_COMPACT` | 环境变量关闭                               |
| user config `autoCompactEnabled`           | 用户关闭时不 compact                       |
| reactive-only mode                         | 部分实验下让 API 413 触发 reactive compact |
| context-collapse enabled                   | context collapse 接管 headroom 问题        |
| consecutive failures >= 3                  | circuit breaker                            |

Token count 使用 `tokenCountWithEstimation(messages) - snipTokensFreed`。`tokenCountWithEstimation` 会优先使用最近 assistant 的真实 API usage，然后估算新增 trailing messages。

关键引用：

| 内容                  | 引用                                          |
| --------------------- | --------------------------------------------- |
| `shouldAutoCompact`   | `src/services/compact/autoCompact.ts:160-239` |
| `autoCompactIfNeeded` | `src/services/compact/autoCompact.ts:241-351` |
| token estimation      | `src/utils/tokens.ts:201-261`                 |

### 5.3 Full compaction 输出结构

`CompactionResult`：

```ts
export interface CompactionResult {
  boundaryMarker: SystemMessage;
  summaryMessages: UserMessage[];
  attachments: AttachmentMessage[];
  hookResults: HookResultMessage[];
  messagesToKeep?: Message[];
  userDisplayMessage?: string;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  compactionUsage?: ReturnType<typeof getTokenUsage>;
}
```

post-compact 顺序固定：

```ts
[
  boundaryMarker,
  ...summaryMessages,
  ...(messagesToKeep ?? []),
  ...attachments,
  ...hookResults
];
```

关键引用：`src/services/compact/compact.ts:299-338`。

### 5.4 Full compaction 算法

`compactConversation()` 的核心步骤：

1. 计算 pre-compact token count。
2. 运行 PreCompact hooks，合并用户/Hook custom instructions。
3. 构造 compact prompt。
4. 启动 summary agent 生成 summary。
5. 如果 compact 请求本身 prompt-too-long，最多 3 次从头部按 API round group 截断重试。
6. 清空 `readFileState` 和 nested memory path state。
7. 生成 post-compact attachments：最近 read files、async agent state、plan、plan mode reminder、skills、deferred tools delta、agent listing delta、MCP instructions delta。
8. 运行 session start hooks。
9. 创建 compact boundary。
10. 创建 summary user message。
11. 返回 `CompactionResult`。

关键引用：`src/services/compact/compact.ts:387-763`。

### 5.5 Compact prompt 内容

summary prompt 要求模型输出：

```text
<analysis>...</analysis>
<summary>...</summary>
```

`<analysis>` 是 drafting scratchpad，后续会剥离，不进入继续上下文。

summary 要覆盖：

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and fixes
5. Problem Solving
6. All user messages
7. Pending Tasks
8. Current Work
9. Optional Next Step

进入后续上下文时，summary 被包装成：

```text
This session is being continued from a previous conversation that ran out of context.
The summary below covers the earlier portion of the conversation.

Summary:
...

If you need specific details from before compaction..., read the full transcript at: <path>
```

关键引用：

| 内容                                  | 引用                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| compact prompt sections               | `src/services/compact/prompt.ts:61-143`                                          |
| no-tools preamble/trailer             | `src/services/compact/prompt.ts:19-26`, `src/services/compact/prompt.ts:269-303` |
| strip `<analysis>` and format summary | `src/services/compact/prompt.ts:305-335`                                         |
| summary message wrapper               | `src/services/compact/prompt.ts:337-360`                                         |

### 5.6 Microcompact

Microcompact 是比 full compact 更细粒度的 tool result 清理，主要针对旧 tool results。

有两条路径：

| 路径                    | 行为                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| time-based microcompact | 如果距离上次 assistant response 很久，server prompt cache 已冷，直接把旧 tool_result content 替换成 `[Old tool result content cleared]` |
| cached microcompact     | 不改本地 messages，只在 API 层通过 cache edits 删除 server-side cached tool results，保护 prompt cache                                  |

time-based microcompact 默认至少保留最近 1 个 compactable tool result。

关键引用：

| 内容                      | 引用                                             |
| ------------------------- | ------------------------------------------------ |
| microcompact 总入口       | `src/services/compact/microCompact.ts:253-293`   |
| cached microcompact       | `src/services/compact/microCompact.ts:295-399`   |
| time-based trigger 和清理 | `src/services/compact/microCompact.ts:422-530`   |
| API context management    | `src/services/compact/apiMicrocompact.ts:64-153` |

### 5.7 Reactive compact

如果实际 API 请求返回 prompt-too-long，query loop 先 withheld 错误，不直接暴露给用户。恢复顺序：

1. context collapse 可用时，先 drain staged collapses 并 retry。
2. 否则尝试 reactive compact。
3. 成功时用 `buildPostCompactMessages(compacted)` 替换当前 messages 并重试。
4. 失败才把 prompt-too-long 错误暴露出来。

关键引用：`src/query.ts:1085-1183`。

## 6. 长期记忆

Claude Code 的长期记忆是文件型系统，不是数据库型 memory store。

### 6.1 CLAUDE.md / rules instruction memory

加载优先级：

1. Managed memory，例如 `/etc/claude-code/CLAUDE.md`。
2. User memory，例如 `~/.claude/CLAUDE.md` 和 `~/.claude/rules/*.md`。
3. Project memory，从 root 到 cwd 逐级加载：`CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md`。
4. Local memory：`CLAUDE.local.md`。
5. additional directories。
6. auto-memory `MEMORY.md`。
7. team memory `MEMORY.md`。

越靠近当前 cwd 的 project memory 加载越晚，优先级越高。`@include` 支持 include 外部 markdown，最大深度 5，并跳过 code block/inline code。

关键引用：

| 内容                                      | 引用                              |
| ----------------------------------------- | --------------------------------- |
| 加载顺序说明                              | `src/utils/claudemd.ts:1-25`      |
| Managed/User/Project/Local 加载           | `src/utils/claudemd.ts:790-933`   |
| additional directories                    | `src/utils/claudemd.ts:936-977`   |
| auto/team memory entrypoint               | `src/utils/claudemd.ts:979-1007`  |
| `getClaudeMds()` 注入文本                 | `src/utils/claudemd.ts:1153-1195` |
| `context.ts` 把 claudemd 放入 userContext | `src/context.ts:152-188`          |

### 6.2 Auto-memory / memdir

Auto-memory 是长期记忆目录，默认路径类似：

```text
~/.claude/projects/<sanitized-project-root>/memory/
```

文件结构：

```text
memory/
  MEMORY.md       # index，始终或经策略加载，不直接存详细正文
  user_role.md    # topic memory file
  feedback_tests.md
  project_x.md
```

topic file frontmatter：

```md
---
name: ...
description: ...
type: user | feedback | project | reference
---
```

`MEMORY.md` 是 index，不应写详细 memory 内容。它会被截断：最多 200 行、25KB，并添加 warning。

Memory prompt 告诉模型：

| 规则                                  | 说明                                    |
| ------------------------------------- | --------------------------------------- |
| 用户明确要求 remember 时立即保存      | 写 topic file，并更新 `MEMORY.md` index |
| 用户要求 forget 时删除相关 entry      | 不保留冲突信息                          |
| topic 语义组织，不按时间组织          | 避免重复，更新旧 memory                 |
| 不保存可从代码/当前项目状态推导的信息 | 这些应通过 read/grep/git 获取           |
| memory 可能 stale                     | 使用前验证文件、函数、flag 是否仍存在   |

关键引用：

| 内容                           | 引用                                                                   |
| ------------------------------ | ---------------------------------------------------------------------- |
| `MEMORY.md` 截断规则           | `src/memdir/memdir.ts:34-103`                                          |
| memory 行为 prompt             | `src/memdir/memdir.ts:199-265`                                         |
| `loadMemoryPrompt()`           | `src/memdir/memdir.ts:409-507`                                         |
| memory 类型和 trust rules      | `src/memdir/memoryTypes.ts:14-31`, `src/memdir/memoryTypes.ts:216-256` |
| auto memory path / enable gate | `src/memdir/paths.ts:21-55`, `src/memdir/paths.ts:207-259`             |

### 6.3 长期记忆写入

有两种写入方式。

第一种是主 agent 直接写。当用户明确说“记住”或“忘记”时，system prompt 要求模型直接用 Write/Edit 写 memory 文件。

第二种是后台 extraction agent。完整 query loop 结束后，如果满足条件，后台 agent 分析最近会话，把可长期保存的信息写入 auto-memory。它只能读项目和写 memory 目录，避免污染其他文件。

关键引用：

| 内容                      | 引用                                                      |
| ------------------------- | --------------------------------------------------------- |
| extract memory agent 入口 | `src/services/extractMemories/extractMemories.ts:166-221` |
| extraction prompt         | `src/services/extractMemories/prompts.ts:29-93`           |

## 7. 短期记忆

短期记忆主要有三类：

| 类型            | 存储                                      | 进入上下文方式                            |
| --------------- | ----------------------------------------- | ----------------------------------------- |
| 当前 transcript | internal `Message[]` / session transcript | recent messages 直接进入，旧内容 compact  |
| compact summary | compact boundary + summary user message   | compact 后替代早期历史                    |
| session memory  | `session-memory/summary.md`               | 主要在 auto-compact 时作为 summary source |

### 7.1 Session memory

Session memory 路径类似：

```text
<project-session-dir>/<sessionId>/session-memory/summary.md
```

模板包含：

| Section                           | 用途              |
| --------------------------------- | ----------------- |
| Session Title                     | 当前 session 名称 |
| Current State                     | 当前状态          |
| Task specification                | 用户任务定义      |
| Files and Functions               | 涉及文件/函数     |
| Workflow                          | 进展流程          |
| Errors & Corrections              | 错误和修正        |
| Codebase and System Documentation | 相关系统文档      |
| Learnings                         | 学到的内容        |
| Key results                       | 关键结果          |
| Worklog                           | 工作日志          |

触发阈值默认：

| 阈值                      | 默认值  |
| ------------------------- | ------- |
| 初始化所需消息 token      | `10000` |
| 两次更新间最小 token 增长 | `5000`  |
| 两次更新间 tool calls     | `3`     |

触发逻辑：

```text
如果还没初始化：token >= init threshold 才初始化。
之后每次更新必须满足 token growth threshold。
同时还要满足 tool call threshold，或当前 assistant turn 没有 tool calls。
```

它只在 main REPL thread 运行，且依赖 auto-compact enabled。

关键引用：

| 内容                        | 引用                                                     |
| --------------------------- | -------------------------------------------------------- |
| 默认阈值                    | `src/services/SessionMemory/sessionMemoryUtils.ts:15-36` |
| `shouldExtractMemory()`     | `src/services/SessionMemory/sessionMemory.ts:134-181`    |
| 创建/读取 summary.md        | `src/services/SessionMemory/sessionMemory.ts:183-233`    |
| extraction hook             | `src/services/SessionMemory/sessionMemory.ts:272-350`    |
| init hook 依赖 auto-compact | `src/services/SessionMemory/sessionMemory.ts:357-375`    |

### 7.2 Session memory 如何进入上下文

Session memory 不是每轮都直接注入。它主要在 compaction 时被使用：

1. `autoCompactIfNeeded()` 先尝试 `trySessionMemoryCompaction()`。
2. 等待正在进行的 session memory extraction 完成。
3. 读取 `summary.md`。
4. 如果文件不存在或仍是模板，fallback 到传统 compact。
5. 如果有内容，则把 session memory 作为 compact summary。
6. 保留 `lastSummarizedMessageId` 之后的 message tail。
7. 构造 compact boundary + summary user message + kept messages。
8. 如果 post-compact 仍超过阈值，fallback。

关键引用：`src/services/compact/sessionMemoryCompact.ts:505-620`。

## 8. RAG / 检索机制

### 8.1 没有发现传统 RAG

没有发现 embedding 模型调用、vector DB、ANN search、semantic vector index 等传统 RAG pipeline。

Claude Code 的替代机制是：

| 机制                              | 作用                                           |
| --------------------------------- | ---------------------------------------------- |
| `MEMORY.md` index                 | 长期记忆入口，通常进入上下文或辅助检索         |
| topic memory frontmatter manifest | 给 LLM selector 选择相关 memory                |
| LLM sideQuery selector            | 从 manifest 里选择最多 5 个 memory files       |
| grep/read 工具                    | 搜索 memory dir 和 transcript JSONL            |
| attachments                       | 把 relevant memory 作为 meta user message 注入 |
| freshness header                  | 告诉模型 memory 是否 stale，需要验证           |

### 8.2 Relevant memory prefetch

Relevant memory 是最接近 RAG 的机制，但不是 embedding RAG。

算法：

1. 每个 user turn 启动一次非阻塞 prefetch。
2. 取最后一个非 meta user message 作为 query。
3. 单词 prompt 不触发。
4. 如果 session 已注入 relevant memory 总 bytes 超限，则不触发。
5. 如果用户 `@agent-*`，只搜该 agent memory dir；否则搜 auto-memory dir。
6. 扫描 memory dir 下 topic `.md`，排除 `MEMORY.md`。
7. 从 frontmatter 取 `name/description/type`，最多扫描 200 个，按 mtime 新到旧。
8. 调 LLM sideQuery 从 manifest 中选择最多 5 个。
9. 过滤已经 surfaced 或 readFileState 已有的文件。
10. 读取选中文件，按 line/byte 限制截断。
11. 作为 `relevant_memories` attachment 注入。
12. `messages.ts` 把 attachment 渲染为 `<system-reminder>` 形式的 meta user message。

关键引用：

| 内容                                  | 引用                                        |
| ------------------------------------- | ------------------------------------------- |
| prefetch 启动                         | `src/utils/attachments.ts:2355-2424`        |
| memory dir 选择和 top 5               | `src/utils/attachments.ts:2196-2242`        |
| memory 读取、截断、freshness header   | `src/utils/attachments.ts:2279-2332`        |
| duplicate filter / readFileState mark | `src/utils/attachments.ts:2507-2540`        |
| query loop 注入 ready attachments     | `src/query.ts:1592-1614`                    |
| attachment 渲染为 system reminder     | `src/utils/messages.ts:3708-3722`           |
| manifest scan                         | `src/memdir/memoryScan.ts:35-94`            |
| LLM selector                          | `src/memdir/findRelevantMemories.ts:77-130` |

### 8.3 Grep 作为 past context search

Memory prompt 明确告诉模型，查找过去上下文时：

1. 先搜索 memory directory 的 topic `.md` 文件。
2. session transcript JSONL 是 last resort。
3. 使用 narrow search terms，如 error message、file path、function name。

关键引用：`src/memdir/memdir.ts:372-407`。

## 9. Skills 与上下文

Skills 不是 memory，但属于上下文能力包。

机制：

| 阶段               | 行为                                                   |
| ------------------ | ------------------------------------------------------ |
| startup/listing    | 只注入 skill 名称和短描述，不注入完整 skill 内容       |
| SkillTool 调用     | 才读取完整 `SKILL.md` 并注入当前 conversation          |
| conditional skills | 通过 `paths` frontmatter 和文件触发动态加入            |
| skill search       | 部分长尾 skill 走 discovery，不全部放入 static listing |

这和 Claude Code 的 memory 思路一致：先给索引/描述，具体内容按需加载。

关键引用：

| 内容                      | 引用                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| skills 路径和加载         | `src/skills/loadSkillsDir.ts:78-94`, `src/skills/loadSkillsDir.ts:638-803` |
| SKILL.md frontmatter      | `src/skills/loadSkillsDir.ts:185-260`                                      |
| skill listing budget/格式 | `src/tools/SkillTool/prompt.ts:20-171`                                     |
| SkillTool 注入完整内容    | `src/tools/SkillTool/SkillTool.ts:957-1107`                                |

## 10. 对 OpenCode-Web-Lite 的启发

### 10.1 最值得借鉴的设计

1. Tool result 不应把完整内部结果自动塞进上下文。
2. 每个 tool 应显式提供 model-facing mapper，决定 `data` 的哪些部分进入 `tool_result.content`。
3. UI-facing result、SDK metadata、runtime context mutation 要和 model-facing content 分离。
4. 大 tool result 应持久化，并给模型 path + preview。
5. 空 tool result 应给模型一个短 marker，避免模型在 tool_result 后无内容可反应。
6. 上下文管理可以先做 pipeline，不必一开始做重型 RAG 排序器。
7. 短期记忆第一版可做 transcript + compact summary + recent messages。
8. 长期记忆第一版可做 file-based markdown memory，而不是数据库向量记忆。
9. RAG 可以先做 manifest + grep/read + LLM selector，再考虑 embedding。
10. Compaction 后要恢复关键 attachments，例如最近文件、plan、skills、memory。

### 10.2 可以映射到当前项目的简化版本

当前项目可先实现：

```ts
type ToolResultEnvelope = {
  modelContent: ToolResultBlock;
  uiDetails?: unknown;
  artifactRefs?: string[];
  contextMutation?: ContextMutation;
};
```

然后在每次模型调用前做：

```text
messages
  -> compact boundary cut
  -> tool result size budget
  -> recent summary injection
  -> memory attachments
  -> normalize for provider
  -> call model
```

第一版不需要 embedding RAG。更实用的是：

1. `read_file` / `search_text` / `apply_patch` 的 model-facing result 设计好。
2. 大输出持久化，给 preview。
3. session summary compaction。
4. project/user markdown memory。
5. manifest + LLM selector 做 relevant memory。
6. 以后再加 vector search。

## 11. 回答本次研究问题

### Tools result 的哪些结构会进入上下文？

进入的是 `tool_result` block 中的：

```ts
type;
content;
is_error;
```

其中 `content` 由每个工具的 `mapToolResultToToolResultBlockParam()` 决定。permission feedback 和 permission 附带 content blocks 可能作为 sibling blocks 进入同一个 user message。

不直接进入的是 `toolUseResult`、`mcpMeta`、`contextModifier`、progress、UI render、transcript render text。

### 长期记忆怎么记录？

长期记忆记录在 markdown 文件系统中：

```text
CLAUDE.md / .claude/CLAUDE.md / .claude/rules/*.md
~/.claude/projects/<project>/memory/MEMORY.md
~/.claude/projects/<project>/memory/*.md
```

`MEMORY.md` 是 index，topic `.md` 文件带 frontmatter。写入可以由主 agent 按用户明确要求执行，也可以由后台 extraction agent 自动提取。

### 长期记忆以什么算法进入上下文？

两条路径：

1. CLAUDE.md / rules / MEMORY.md entrypoint 经 `getMemoryFiles()` 加载，进入 `userContext.claudeMd`。
2. Relevant memory prefetch 扫描 topic file manifest，用 LLM sideQuery 选最多 5 个，读文件后作为 `relevant_memories` attachment 注入。

没有发现 embedding/vector search。

### 短期记忆怎么记录？

短期记忆记录在：

1. 当前 internal `Message[]`。
2. compact summary user message。
3. session memory `summary.md`。

Session memory 由 post-sampling hook 根据 token/tool-call 阈值后台更新。

### 短期记忆以什么算法进入上下文？

常规情况下 recent messages 直接进入；旧消息通过 full compact / partial compact / session memory compact 变成 summary。Session memory 主要在 auto-compact 时作为 summary source，而不是每轮都注入。

### 上下文总体结构是什么？

```text
system blocks:
  attribution + CLI prefix + core prompt + memory behavior + dynamic system context

tools:
  filtered base/MCP/deferred tool schemas

messages:
  compact boundary, usually internal
  compact summary as user message
  preserved recent messages
  attachments as meta user messages
  user prompts
  assistant text/thinking/tool_use
  user tool_result blocks
```

实际 API payload 由 `paramsFromContext()` 输出，`system`、`messages`、`tools` 是三个分离的 top-level 字段。
