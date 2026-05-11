# RFC: Context Budget 与 Compact

Status: Proposed

Owner: OpenCode

Last Updated: 2026-05-10

Audience: 人类维护者、coding agent

## 1. 背景

当前项目已经完成了上下文骨架和工具主链路。

现有有效链路是：

```text
ContextBuilder
  -> AiSdkRequestAdapter
  -> SessionProcessor
  -> ToolExecutor
  -> RunLoop
  -> Lifecycle
```

当前还缺两类关键能力。

第一，缺少真正可用的上下文预算控制。`ContextSizeGuard` 目前仍然只会在超限时抛出 `context_too_large_compact_not_implemented`，随后 `RunLoop` 把结果上抛给 `Lifecycle`，再把 session/run 收敛为 `blocked`。这意味着系统还没有“超限先自救，再失败才阻塞”的能力。

第二，缺少真正的 compact 实现。虽然共享 DTO 已经预留了 `MessagePart.type = 'compaction' | 'summary'`、`ToolState.compactedAt?`、`MessageDto.compactedByMessageId?` 等字段，但这些字段还没有被 runtime 主链路真正使用。

本 RFC 目标是把“上下文预算 + tool output 压缩 + full compact + compact 后继续运行”收敛成一个适合当前项目、可由 coding agent 直接照章落地的正式方案。

## 2. 目标

1. 引入模型相关的上下文预算模型，而不是继续只靠固定字符/Token 上限硬拦截。
2. 在 full compact 之前，先做确定性的旧 tool output 压缩，优先回收最大头的上下文体积。
3. 实现显式、durable、可观察的 full compact。
4. compact 结果必须进入 durable transcript，而不是只存在于内存态。
5. auto compact 成功后，不阻断当前任务，而是继续当前 run。
6. manual compact 成功后，compact 流程直接结束，不自动继续当前任务。
7. compact 必须对恢复、调试和事件追踪友好。
8. 首版方案必须尽量复用现有 `Message + Part`、`SessionProcessor`、`ToolExecutor`、`file_snapshot` artifact 和 server wiring，不额外引入重量级 memory 子系统。

## 3. 非目标

1. 不在首版实现 `claude-code` 级别的 session memory。
2. 不在首版实现 preserved tail relink、preserved segment graph 修复。
3. 不在首版实现 API-level microcompact、cache edits、history snip。
4. 不在首版持久化 provider-native conversation state。
5. 不在首版引入新的 transcript 文件系统或本地日志文件作为 compact 真源。
6. 不在首版处理 dynamic tool discovery snapshot；当前工具集合仍由 `resolveTools()` 每轮重建。
7. 不在首版实现完整的手动 compact UI；但本 RFC 会先定义其行为语义。

## 4. 设计输入

本 RFC 综合了三类设计输入。

### 4.1 当前项目现状

当前项目已经具备以下基础：

1. `ContextBuilder` 已经把 `compaction` part 隐藏掉，并把 `summary` 映射成普通文本上下文。
2. `RunLoop` 已经能把上下文构建、工具注册、请求适配、模型执行和 tool execution 串起来。
3. `SessionProcessor` 已经能持久化 assistant text、reasoning、tool part、token usage 和 provider metadata。
4. `read`、`edit`、`write`、`apply_patch` 等工具已经会把文件快照落到 `artifacts.kind = 'file_snapshot'`。

### 4.2 从 `../opencode` 借鉴的点

1. compact 应该是显式会话事件，而不是隐藏在 runtime 内部的不可见行为。
2. 最近一次成功 compact 之后的消息，才是后续上下文构建的有效历史。
3. 旧 tool output 应该能单独压缩，而不是一上来就全量做 summary。

### 4.3 从 `../claude-code` 借鉴的点

1. full compact 不是“只生成一段 summary”，而是“summary + compact 后小工作集重建”。
2. compact 请求本身也可能过长，因此需要独立的 prompt-too-long 重试策略。
3. compact 过程应强制禁止工具调用。
4. compact 成功后，应该为下一轮恢复少量必要上下文，而不是只留下 summary 一段文本。

## 5. 核心判断

### 5.1 本项目不直接照搬 `opencode` 或 `claude-code`

本项目最合适的路线不是：

1. 只做一个纯 summary compact。
2. 也不是一次性引入完整的多层 memory / microcompact / preserved tail 体系。

本项目应该采用一个中等复杂度方案：

```text
预算分析
  -> 旧 tool output 压缩
  -> full compact
  -> compact 后重建最小工作集
  -> 继续原 run 或结束 manual compact
```

### 5.2 compact 必须显式、durable、可回放

compact 不能只发生在内存里，否则会带来三个问题：

1. 无法审计模型到底看到了什么。
2. 无法在 server 重启后恢复 compact 进行到哪一步。
3. 无法在 UI 中标记“这里发生过一次上下文压缩”。

因此，compact 必须通过现有 transcript 数据模型落库。

### 5.3 full compact 之后继续运行，必须强调“重新构建上下文”

本项目不应采用“把 run 到一半的内存上下文直接拼回去”的说法或做法。更准确的语义是：

1. compact 把旧历史折叠为 compact summary。
2. compact 追加 post-compact context。
3. 下一步重新从 durable transcript 构建上下文。
4. 然后继续原 `RunLoop`。

### 5.4 `post-compact context` 的定义

本 RFC 中的 `post-compact context` 指：

1. 在 compact summary 之外。
2. 为了让下一轮继续工作而额外补回去的。
3. 小而关键的工作材料。

它不是：

1. system prompt。
2. tool registry。
3. approval / checkpoint / session status。
4. provider conversation id。

这些都仍然按现有路径重建，而不是 compact 后额外注入。

另外，`post-compact context` 不能落为普通 `user` message。否则它会被当前 `ContextBuilder` 误判为新的 `lastUser`，直接影响 compact 之后继续运行时的 `model`、`agentName`、`runtime` 和 `resolveTools()` 选择。首版必须把它落为不会参与 `lastUser` 选择的结构。

### 5.5 工具集合不会因为 compact 丢失

当前项目的工具集合不是靠消息历史保存的，而是每轮由 `resolveTools()` 基于：

1. 当前 agent。
2. 当前 model。
3. 当前 runtime metadata。
4. 当前 tool overrides。

重新 resolve 出来。

因此首版 compact 不需要额外保存 tool registry snapshot。本项目需要保留的是“影响继续工作的语义上下文”，而不是 `resolveTools()` 的结果对象本身。

## 6. 现有基础与落点

本 RFC 直接落在以下现有代码基础上：

1. `packages/agent/src/context/builder.ts`
2. `packages/agent/src/context/size-guard.ts`
3. `packages/agent/src/context/ai-sdk-request-adapter.ts`
4. `packages/agent/src/run-loop.ts`
5. `packages/agent/src/session-processor.ts`
6. `apps/server/src/wiring/agent.ts`
7. `apps/server/src/services/agent/file-snapshot-service.ts`
8. `apps/server/src/repositories/artifact-repository.ts`

其中最重要的现有数据模型字段如下：

1. `MessagePart.type = 'compaction'`
2. `MessagePart.type = 'summary'`
3. `ToolState.completed.compactedAt?`
4. `MessageDto.summary?`
5. `MessageDto.compactedByMessageId?`

## 7. 总体方案

### 7.1 三层预算模型

当前 `ContextSizeGuard` 只有固定上限。首版应改为三层预算：

1. `softBudgetTokens`
2. `compactTriggerTokens`
3. `hardFailTokens`

建议的计算方式：

```text
effectiveInputBudget = contextWindowTokens - reserveOutputTokens - reserveCompactTokens
```

建议字段：

1. `contextWindowTokens`
2. `reserveOutputTokens`
3. `reserveCompactTokens`
4. `softBudgetTokens`
5. `compactTriggerTokens`
6. `hardFailTokens`

首版不要求完整 provider metadata 系统，但要求 server wiring 至少能为当前主模型注入一个保守 budget 配置。

### 7.2 两阶段 compact pipeline

首版 compact pipeline 采用以下顺序：

```text
build context
  -> budget analysis
  -> deterministic old tool output compaction
  -> rebuild estimate
  -> full compact if still too large
  -> rebuild context from transcript
  -> continue or stop
```

### 7.3 旧 tool output 压缩先于 full compact

当上下文接近 soft budget 时，先从历史里压缩较老的 completed tool output。

规则如下：

1. 只处理 `status === 'completed'` 的 tool part。
2. `pending`、`running`、`error` tool part 不动。
3. 最近 2 个 user turns 的 tool output 不动。
4. 最近 1 次 assistant 回复中的 tool output 不动。
5. 更早的 completed tool output 只标记 `compactedAt`，不删除 part。
6. `toToolResultOutput()` 在看到 `compactedAt` 时，不再把原始 `outputText` 放给模型，而是输出稳定占位文本。

这一步是 deterministic shrinking，不依赖额外模型调用。

### 7.4 full compact 的 durable 表示

当前项目没有 `claude-code` 的 `system.compact_boundary` message type，因此本 RFC 采用当前已有数据模型表达 compact boundary：

1. 创建一个显式 `user` message。
2. 该 message 包含一个 `part.type = 'compaction'`。
3. 该 part 至少包含：`auto`、`reason`、`targetMessageId`。
4. compact 成功后，再创建一个 `assistant` summary message。
5. 该 assistant message 至少包含：`summary: true` 和一个 `part.type = 'summary'`。

在本项目里：

```text
显式 compaction request message + 成功 compact summary message
```

共同构成 durable compact boundary。

后续 `filterCompacted()` 以“最近一次成功 compact request + summary pair”为切分边界。

### 7.5 post-compact context 的 durable 表示

当前项目没有独立 attachment message 类型，因此首版 `post-compact context` 仍应落为正常 transcript 数据，但不能落为普通 `user` message。

建议表示方式：

1. 在 compact summary assistant message 之后。
2. 追加一个或多个 synthetic assistant message。
3. 这些 message 只包含恢复出来的 `summary` 或 `text` parts。
4. 这些 message 的语义是“compact 后恢复的小工作集上下文”，而不是新的用户输入。

首版 `post-compact context` 至少支持：

1. 恢复最近读过的关键文件上下文。
2. 预留 `SessionStart` 扩展点输出的文本上下文。

首版不要求恢复：

1. skills。
2. deferred tools delta。
3. agent listing delta。
4. MCP instructions delta。

这些都留给后续阶段。

## 8. Full Compact 详细算法

本节定义首版 `full compact` 的正式执行算法。

### 8.1 计算 `preCompactTokenCount`

full compact 开始前，先计算 `preCompactTokenCount`，作为以下能力的基础：

1. compact 诊断。
2. 事件记录。
3. compact 自己 prompt-too-long 重试的决策依据。

### 8.2 执行 `PreCompact` 扩展点

在 compact summary 生成前，执行 `PreCompact` 扩展点。

用途：

1. 补充 compact 指令。
2. 生成用户可见提示。

首版允许该扩展点为空实现，但必须预留函数边界。

### 8.3 构造 compact prompt，并启动一个无工具 summary 子流程

compact 使用专用 prompt，并以当前主模型启动一个“仅输出文本、禁止工具调用”的 summary 子流程。

首版建议：

1. 默认复用当前主模型。
2. 不单独引入 compaction model。
3. summary 子流程复用现有 `SessionProcessor` 执行流式持久化。
4. 该子流程的 `tools` 为空，任何 tool call 都视为 compact failure。

### 8.4 compact 输入应先剥离可重建的大块上下文

compact summary 请求会移除不必参与总结、且后续可重建的上下文块，以降低 compact 自身的输入体积。

首版允许剥离的内容：

1. 不需要进入摘要的大媒体内容。
2. 后续会通过最近 read tool outputs 恢复重新注入的部分文件上下文。
3. 已经单独做过 `compactedAt` 处理的旧 tool output 原文。

本项目首版不应假定存在完整的 attachment rehydration 体系，因此只能移除那些已经明确具备恢复路径的上下文块。

### 8.5 compact 自己 PTL 时，最多按历史分组重试 3 次

如果 compact 请求本身命中 `prompt too long`，系统最多重试 3 次。每次都从最老历史开始裁剪，再重新请求 compact summary。

这里借鉴 `claude-code` 的 “API round group” 思路，但需要适配本项目的 transcript 结构。

首版在本项目中的安全分组定义是：

```text
一个 user message
  + 其后直到下一个 user message 之前的所有 assistant messages/parts
```

原因：

1. 当前项目的 tool call/result 已经内嵌在 assistant message 的 parts 中。
2. 按 user-turn group 裁剪，能保证较老的 user request 与其后续 assistant/tool history 一起被移除。
3. 这比按单条 message 生切更安全，也比在首版引入更细粒度 pairing 修复更简单。

但本 RFC 也明确承认：该策略在“单用户长回合”场景下能力有限。也就是一个 user message 后面跟了大量 assistant/tool 循环、但没有新的 user message 时，首版可能只有一个可裁剪 group，PTL 重试空间很小，最终仍可能直接 compact 失败。这个限制在首版是接受的，后续如有需要，再演进为更细的 assistant-round 分组。

### 8.6 compact summary 的输出格式与格式化

compact summary 的模型输出允许采用以下双段格式：

```text
<analysis>
...
</analysis>

<summary>
...
</summary>
```

但真正持久化前，必须经过 `formatCompactSummary()` 处理：

1. 删除 `analysis` 草稿。
2. 只保留 `summary` 正文。

这样做的目的是：

1. 允许模型先做草稿式整理，提高 summary 质量。
2. 又不把草稿内容继续带入后续上下文。

### 8.7 compact 成功后，清空短期 working set，并生成 `post-compact context`

compact 成功后，系统应清空可重建的短期 working set，并生成 `post-compact context`。

这里的“清空”不是清空 session runtime state、approval state、checkpoint 或 tool call state，而是清空可以从 transcript 或 artifact 重新恢复的短期工作集。

首版至少要求：

1. 恢复最近读过的关键文件上下文。
2. 恢复来源应优先利用最近 `read` tool outputs；`file_snapshot` artifacts 主要用于 freshness / eligibility 校验，而不是直接作为文件内容来源。
3. 预留 `SessionStart` 扩展点。

### 8.8 auto compact 成功后，继续当前 `RunLoop`

自动 compact 成功后，不直接结束本次运行，而是：

1. 持久化 `compaction` request message。
2. 持久化 compact summary assistant message。
3. 持久化 `post-compact context` synthetic assistant message。
4. 重新从 transcript 构建：

```text
compact boundary + compact summary + post-compact context + recent suffix
```

5. 然后继续原 `RunLoop`。

### 8.9 manual compact 成功后，流程直接结束

手动 compact 成功后，compact 流程直接结束，不自动继续原任务执行。

即使 manual compact 的入口在首版晚于 auto compact 才实现，其行为语义也必须在本 RFC 先固定：

1. compact 成功后返回结果。
2. 不自动继续原任务。
3. 由用户下一次明确输入决定后续执行。

### 8.10 compact 完成时，必须形成一个显式 durable boundary

compact 完成时，系统必须形成一个显式 durable boundary，作为后续以下逻辑的依据：

1. `filterCompacted()`
2. 历史裁剪
3. 恢复
4. 调试

在本项目首版里，这个 durable boundary 由：

```text
最新成功的 compaction request message + compact summary assistant message
```

共同定义。

## 9. compact summary 的建议模板

首版 compact prompt 不建议只要求一段自由文本，而应要求半结构化 summary，至少覆盖以下部分：

1. `Current Objective`
2. `Important Constraints`
3. `Relevant Files / Areas`
4. `Decisions Already Made`
5. `Outstanding Work`
6. `Tool Findings Worth Preserving`
7. `Open Risks / Unknowns`

这比自由摘要更稳定，也更适合 compact 后继续执行。

## 10. 对当前数据模型的具体语义约束

### 10.1 `filterCompacted()`

`filterCompacted()` 需要改成真正的 compact 切分入口。

建议语义：

1. 找到最近一个 `compaction` request message。
2. 检查其后是否存在成功的 compact summary assistant message。
3. 如果存在，只保留这次 compact 之后的 suffix。
4. 如果不存在，说明 compact 尚未完成，不裁剪历史。

### 10.2 `ToolState.compactedAt`

`compactedAt` 是旧 tool output 压缩标记，而不是 full compact 成功标记。

它的语义是：

1. 该 tool result 仍然保存在 transcript 中。
2. 但其原始大输出不再继续进入模型上下文。

### 10.3 `MessageDto.compactedByMessageId`

`compactedByMessageId` 建议放到后续阶段。

首版 full compact 不要求必须回填这个字段，但需要在 RFC 中保留其用途：

1. 标记哪些旧消息被哪次 compact 覆盖。
2. 提升 UI 和调试可观察性。

## 11. 模块与代码改动清单

### 11.1 `packages/agent/src/context/size-guard.ts`

从“超限即 throw”改为“返回结构化 budget analysis / recommendation”。

至少需要区分：

1. fits
2. needs_tool_result_compaction
3. needs_full_compaction
4. unrecoverable

### 11.2 `packages/agent/src/context/builder.ts`

需要新增或完成：

1. `filterCompacted()`
2. compact 相关 history suffix 选择逻辑
3. 可能的 compacted tool output 可见性辅助逻辑

### 11.3 `packages/agent/src/context/ai-sdk-request-adapter.ts`

需要补充：

1. `compactedAt` tool result 的稳定占位输出
2. compact summary 格式化辅助逻辑的接入点

### 11.4 新增 compact 组件

建议新增：

1. `packages/agent/src/session-compaction.ts`

职责：

1. 计算 compact 输入
2. 创建 compaction request message
3. 执行 compact summary 子流程
4. 执行 PTL 重试
5. 格式化 summary
6. 生成不会参与 `lastUser` 选择的 `post-compact context`
7. 持久化 compact 相关消息和事件

### 11.5 `packages/agent/src/run-loop.ts`

需要在主循环中加入：

1. budget analysis
2. old tool output compaction
3. full compact 调用
4. compact 成功后的 rebuild-and-continue

### 11.6 `apps/server/src/wiring/agent.ts`

需要为 compact 组件接入：

1. `createMessage`
2. `appendMessagePart`
3. `updateMessageRuntime`
4. `appendSessionEvent`
5. `streamModelResponse`
6. `modelFactory`
7. file snapshot 读取能力

### 11.7 `apps/server/src/services/agent/file-snapshot-service.ts`

首版建议补充“按 session 列出最近快照”的能力，供 `post-compact context` 做 freshness / eligibility 校验；真正的文件恢复内容应优先来自最近 `read` tool outputs 或必要时重新读取文件。

## 12. 分阶段交付

### Phase 1

1. budget model
2. deterministic old tool output compaction
3. `compactedAt` model-visible placeholder

### Phase 2

1. full compact
2. `preCompactTokenCount`
3. `PreCompact` no-op extension
4. no-tool summary sub-run
5. PTL retry by user-turn group（并明确单用户长回合场景下能力有限）
6. `formatCompactSummary()`
7. `filterCompacted()`

### Phase 3

1. `post-compact context` 最近关键文件恢复
2. `SessionStart` no-op extension
3. auto compact 后继续原 `RunLoop`

### Phase 4

1. manual compact entrypoint
2. `MessageDto.compactedByMessageId`
3. compact 中断恢复

## 13. 测试与验收标准

首版至少需要覆盖以下测试。

1. 上下文未超限时，不触发 compact。
2. 上下文接近 soft budget 时，先触发旧 tool output 压缩。
3. 旧 tool output 压缩后若已降回预算内，不触发 full compact。
4. full compact 成功后，会产生显式 compaction request message 和 compact summary assistant message。
5. compact summary 中的 `<analysis>` 不会进入后续上下文。
6. compact 请求命中 PTL 时，最多重试 3 次，并按 user-turn group 从最老历史裁剪；RFC 明确承认该策略在单用户长回合场景下能力有限。
7. auto compact 成功后，`RunLoop` 会重新构建上下文并继续当前任务。
8. manual compact 成功后，不自动继续原任务。
9. `filterCompacted()` 只使用最近一次成功 compact 之后的 suffix。
10. 最近关键文件可以作为 `post-compact context` 被恢复进 transcript，且其内容来源不假定 `file_snapshot` artifact 本身已保存正文。
11. compact 过程中若模型尝试调用工具，compact 会失败。

## 14. 结论

本项目的 compact 首版不追求 `claude-code` 级别的完整生态，也不应退回到“超限直接 blocked”的初级方案。

最合适的路线是：

1. 先做预算建模。
2. 先做 deterministic old tool output compaction。
3. 再做显式、durable、可恢复的 full compact。
4. auto compact 成功后继续当前 run。
5. manual compact 成功后只结束 compact 流程。

这条路线与当前项目的 `Message + Part` transcript、`SessionProcessor`、`RunLoop`、`file_snapshot` artifact 和 server wiring 高度兼容，能够以最小正确增量把 compact 从“阻塞点”升级为“自恢复能力”。
