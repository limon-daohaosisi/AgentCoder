# RFC: 统一 Prompt Source Resolver 与 AGENTS.md 项目记忆注入

Status: Proposed

Owner: OpenCode

Last Updated: 2026-05-11

Audience: 人类维护者、coding agent

## 1. 背景

当前项目已经具备可运行的 agent 主链路。

现有有效链路是：

```text
ContextBuilder
  -> buildSystemContext()
  -> resolveTools()
  -> AiSdkRequestAdapter
  -> SessionProcessor
  -> RunLoop
  -> Lifecycle
```

当前与提示词处理相关的实现分布在以下位置：

1. `packages/agent/src/prompt.ts`：核心 system prompt。
2. `packages/agent/src/context/system-context.ts`：environment、variant、userSystem、format 组装。
3. `packages/agent/src/context/builder.ts`：上下文构建。
4. `packages/agent/src/context/tool-registry.ts`：工具暴露与 enable/disable。
5. `packages/agent/src/context/ai-sdk-request-adapter.ts`：system/messages/tools 转 AI SDK request。
6. `packages/agent/src/session-compaction.ts`：compact 专用 prompt overlay。
7. `packages/agent/src/tools/*/prompt.ts`：每个工具自己的模型可见描述。

当前实现已经能工作，但仍有四个结构性问题。

第一，系统提示词来源还没有被建模成显式 source。当前 `SYSTEM_PROMPT`、environment、模式提醒、用户附加 system、JSON schema 约束都在不同函数里逐步拼接，后续再引入 `AGENTS.md` 或其他长期记忆时，容易继续把逻辑分散到更多文件中。

第二，当前 runtime 还没有 external instruction file 注入能力。虽然 `ContextSystemBlock.source` 已经预留了 `memory` 和 `skill_list`，`insertReminders()` 和 `sessionStartBlocks()` 也预留了扩展点，但这些路径都还没有真正启用。

第三，normal turn 和 compact turn 还没有通过“同一套 prompt source 模型”显式绑定。虽然 compact 现在会复用 `input.context.system`，但这只是当前实现碰巧成立；一旦后续新增长期记忆或多层 source，而这些 source 没有进入 `ContextBuilder` 的稳定输出，compact 很容易和 normal turn 语义漂移。

第四，项目需要一个统一的、可测试的 prompt 装配入口，但不应该把所有模型输入都拍扁成一个字符串。system prompt、工具描述、模型不可见控制元数据，本来就属于不同通道。统一的是装配流程，不是把所有东西合并成一个文本 blob。

本 RFC 的目标，是为当前项目定义一套中等复杂度、可直接落地的 prompt 架构：

```text
workspace/session/runtime input
  -> server-side external memory source loader
  -> agent-side PromptBundle assembly
  -> ContextBuilder
  -> normal request / compact request
```

该方案首版只引入 workspace 根级 `AGENTS.md` 作为项目长期记忆，不直接照搬 `../opencode` 的多层 instruction 路径，也不直接引入 `../claude-code` 级别的 memory/rules/session-memory 体系。

## 2. 设计输入

本 RFC 综合了三类设计输入。

### 2.1 当前项目现状

当前项目已经具备以下基础：

1. `SYSTEM_PROMPT` 已经明确了 coding agent 的核心行为规则。
2. `buildSystemContext()` 已经能输出 `core`、`environment`、`instruction`、`user_system`、`format` 等 system blocks。
3. `ContextSystemBlock.source` 已经预留了 `memory`、`skill_list`，说明数据模型层面已经考虑过长期记忆和技能列表。
4. `resolveTools()` 与 `tools/*/prompt.ts` 已经形成“工具定义自己拥有 prompt，运行时统一收集”的较好结构。
5. `session-compaction.ts` 已经有 compact overlay prompt，并且 compact request 会复用 normal context 的 system text。
6. `insertReminders()` 与 `sessionStartBlocks()` 目前为空实现，适合作为后续 reminder / 局部 instruction 的扩展点。

### 2.2 从 `../opencode` 借鉴的点

`../opencode` 的提示词体系不是单一 prompt 文件，而是“集中装配、分散来源”：

1. `session/prompt.ts` 作为统一装配入口，收集 system、environment、instructions、messages、tools。
2. `session/instruction.ts` 负责发现 `AGENTS.md`、可选 `CLAUDE.md`、配置文件和 URL 指令。
3. 工具自己的模型提示词继续留在各工具目录。
4. compact 走自己的 prompt，但仍复用同一运行时链路。

本项目最值得借鉴的点是：

1. 要有一个统一的 prompt 装配入口。
2. instruction file discovery 应该放在 runtime 外围，而不是散到 agent core 内部。
3. 项目说明文件应该被视为正式的 prompt source，而不是零散特判。

### 2.3 从 `../claude-code` 借鉴的点

`../claude-code` 的提示词体系更厚重，但其中有三点值得吸收：

1. system prompt 不是一整块字符串，而是稳定顺序的多 section 组合。
2. 外部项目规则、memory behavior、tool prompts、compact prompts 属于不同通道，不应全部拍扁到同一层字符串里。
3. compact prompt 应该建立在 normal turn 的 base prompt 之上，再叠加 compact-specific overlay。

本项目不适合直接照搬的部分是：

1. 多层 managed/user/project/local memory。
2. `.claude/rules`、frontmatter path scoping、`@include` 体系。
3. session-memory 与 compact 的双系统。
4. prompt cache 边界和 schema cache 的大规模优化。

## 3. 目标

本 RFC 的目标如下：

1. 将当前项目的提示词来源抽象成统一的 Prompt Source Resolver，而不是继续靠多个位置隐式拼接字符串。
2. 定义清晰的 prompt 通道分层：system channel、tool channel、control channel、debug channel。
3. 在首版支持 workspace 根目录 `AGENTS.md` 作为 `project memory` 注入 system prompt。
4. 保持 `tools/*/prompt.ts` 的工具 prompt 模式，不把工具描述回塞到 system prompt。
5. 让 compact 和 normal turn 共享同一套 base prompt sources，只在 compact 时追加 overlay。
6. 保持 `packages/agent` 对最终 prompt block 顺序和装配语义的所有权，同时不让 agent core 直接读 workspace 文件系统。
7. 为后续 path-scoped reminders、skills、更多 memory source 留下清晰扩展点。
8. 引入最小但可观测的 debug 结构，便于测试 prompt source 顺序和来源。

## 4. 非目标

本 RFC 首版明确不做以下事情：

1. 不兼容 `CLAUDE.md`、`CONTEXT.md`、全局 instruction file、远程 URL instruction。
2. 不实现 path-scoped `AGENTS.md` 递归合并。
3. 不实现 read-time 局部 instruction reminder。
4. 不实现 session memory / auto memory / vector memory。
5. 不引入新的数据库 schema 或新的持久化 memory 表。
6. 不将 `AGENTS.md` 内容持久化进 durable transcript。
7. 不在首版重构工具注册主链路，不一次性把 tool channel 也迁入同一个 resolver 实现。
8. 不在首版引入 prompt cache 边界、schema cache、deferred tool loading 等高级优化。

## 5. 核心判断

### 5.1 统一的是装配流程，不是单一字符串

本项目需要的不是一个：

```ts
resolvePrompt(): string
```

而是一个返回结构化结果的 resolver，例如：

```ts
type PromptBundle = {
  systemBlocks: ContextSystemBlock[];
  debugSources: PromptSourceDebug[];
};
```

原因如下：

1. system prompt、工具描述、控制元数据进入模型的通道不同。
2. compact 需要在 base system prompt 之上叠 overlay，而不是重新拼一条完全不同的字符串。
3. 未来要做调试和测试时，必须知道每一段 prompt 文本来自哪里。

### 5.2 Prompt Source Resolver 不等于一次性吞掉所有 tool logic

从长期结构上看，统一的 turn assembly 应该覆盖：

1. system blocks。
2. 模型可见元数据。
3. resolved tools。
4. compact overlay。

但从当前项目的最小改造面出发，首版不应为了“名义上的统一”而把 `resolveTools()` 整个迁移重写。

首版判断如下：

1. 先统一 system/instruction/memory 侧的 source 解析与装配。
2. 保持工具 prompt 继续由各工具目录维护。
3. 保持 `resolveTools()` 继续作为 tool channel 的主入口。
4. 在概念上把 `resolveTools()` 视为 turn assembly 的平行通道，而不是继续和 system prompt 混成一个层次。

### 5.3 首版应该叫 `PromptBundleResolver` 或 `PromptContextResolver`，而不是 `SystemPromptResolver`

原因是：

1. 它不只是拼 system prompt。
2. 它还要决定 memory block、environment block、runtime instruction block 的顺序。
3. 它未来还会自然扩展出 session-start blocks 和 prompt debug sources。

因此，本 RFC 中统一使用 `PromptBundleResolver` 这一称呼。后续如果真的把 tools 也完全纳入同一 facade，再引入 `TurnContextResolver`。

### 5.4 `AGENTS.md` 首版是 workspace-level project memory，而不是 transcript 内容

`AGENTS.md` 首版应满足以下语义：

1. 它是项目级长期规则。
2. 它在每个 turn 构建模型请求时 live 读取并注入。
3. 它属于 system channel，而不是消息历史。
4. 它不应落为 synthetic assistant message。

将 `AGENTS.md` 写入 transcript 的问题是：

1. 会污染 durable transcript，把“项目配置”误写成“对话事实”。
2. 会让 compact summary 不必要地总结这类长期静态规则。
3. 会使一条项目说明在历史中重复累积。

这里的“按 turn live 读取”定义如下：

1. 每次 `ContextBuilder.build(...)` 为下一次模型请求重建上下文时，都重新读取 `AGENTS.md`。
2. 同一 run 中的多步循环，如果 `AGENTS.md` 在中途被修改，后续 step 可以看到新内容。
3. manual compact 和 auto compact 也遵循同一语义。
4. 首版不做 run-level snapshot，不保证一次 run 内所有 step 看到的 `AGENTS.md` 字节完全相同。

### 5.5 compact 必须复用同一套 base prompt sources

compact 不是独立 prompt 世界。它的 system prompt 应等于：

```text
normal base system blocks
  + compact overlay instruction
```

这意味着：

1. `AGENTS.md` 在 compact 时也必须可见。
2. `variant`、`userSystem`、`format` 在 compact 时也必须保留。
3. compact-specific 限制，例如“禁止工具调用”，只应作为 overlay 增量出现。

### 5.6 `packages/agent` 不直接读文件系统

当前项目对 `packages/agent` 的定位已经很清楚：它是纯 runtime core，不依赖 server service、repository、workspace 文件系统。

因此：

1. `AGENTS.md` 的发现与读取必须放在 `apps/server`。
2. `packages/agent` 继续负责最终 prompt block 的顺序、拼装和 compact base system 语义。
3. server 只负责提供 external memory sources 或其他外部 augmentations，而不是决定最终 `PromptBundle` 长什么样。
4. 这条边界比“把所有逻辑都塞在 builder.ts 里”更重要。

## 6. 目标架构

### 6.1 Prompt 通道分层

本项目的提示词体系应显式分为 4 个通道。

#### 6.1.1 system channel

真正拼成模型 system/instructions 文本的内容，包括：

1. core system prompt。
2. project memory，例如 `AGENTS.md`。
3. environment info。
4. runtime instruction，例如 `variant`。
5. userSystem。
6. response format 约束。

#### 6.1.2 tool channel

通过 tool schema / tool description 暴露给模型的内容，包括：

1. `tools/*/prompt.ts`。
2. tool input schema。
3. tool enable/disable。

首版保持现有 `resolveTools()` 路径，不回塞到 system channel。

#### 6.1.3 control channel

仅用于控制装配和运行，不直接进入模型文本的内容，包括：

1. `sessionId`。
2. `workspaceRoot`。
3. 当前 model/provider。
4. 工具开关。
5. compact mode flag。
6. 调试和日志开关。

#### 6.1.4 debug channel

供测试与诊断使用，不直接进入模型的结构化来源信息，包括：

1. 每个 prompt source 的 kind。
2. 来源路径或来源 ID。
3. 是否被截断。
4. 最终顺序。

### 6.2 高层流程

目标流程如下：

```text
Session / Workspace / Runtime Metadata
  -> workspaceMemoryService
  -> ContextBuilder.build(...)
      -> PromptBundleResolver (agent-side)
  -> resolveTools(...)
  -> toAiSdkTurnRequest(...)
  -> streamText(...)

compact:
  -> ContextBuilder.build(...)
  -> reuse built system blocks
  -> append compact overlay
  -> summary subflow
```

### 6.3 数据模型

首版建议新增以下纯类型。

```ts
type PromptSourceDebug = {
  kind:
    | 'core'
    | 'memory'
    | 'environment'
    | 'instruction'
    | 'user_system'
    | 'format';
  origin?: string;
  sourceId: string;
  truncated?: boolean;
};

type PromptBundle = {
  debugSources: PromptSourceDebug[];
  systemBlocks: ContextSystemBlock[];
};
```

其中：

1. `systemBlocks` 是当前 turn 的真实 system channel 输出。
2. `debugSources` 用于测试和可观察性。

首版另外建议新增一个仅供组装使用的外部 source 类型：

```ts
type PromptMemorySource = {
  origin?: string;
  sourceId: string;
  text: string;
  truncated?: boolean;
};
```

其中：

1. `PromptMemorySource` 不是最终 system block。
2. 它代表 server 注入给 agent core 的外部 memory source。
3. `packages/agent` 内部的 `PromptBundleResolver` 负责把它转换成 `source = 'memory'` 的 block，并放到固定顺序中。

### 6.4 首版 system block 顺序

首版顺序必须固定如下：

1. `core`
2. `memory`
3. `environment`
4. `instruction`
5. `user_system`
6. `format`

理由如下：

1. `core` 是最基础、最稳定的行为规则。
2. `memory` 是项目长期规则，应当在环境信息之前出现。
3. `environment` 是当前运行事实。
4. `instruction`、`user_system`、`format` 都是本轮更贴近用户请求的覆盖层。

首版应尽量保留已有 block 文案，避免一次性修改太多模型行为。也就是说：

1. `variant` 仍保留当前 `<system-reminder>` 风格。
2. `userSystem` 暂时继续以当前裸文本方式进入 `user_system` block。
3. `format` 暂时继续保留当前文本风格。
4. 只为新的 project memory block 引入明确包裹标签。

这类 runtime instruction block 属于 system channel，而不是 transcript。例如：

```text
<system-reminder>
Your operational mode has changed from plan to build.
You are no longer in read-only mode.
You are permitted to make file changes, run shell commands, and utilize your arsenal of tools as needed.
</system-reminder>
```

是否能生成“从 plan 切到 build”的变化式文案，取决于 runtime 是否提供前一模式信息；但无论文案如何，这类 reminder 都属于 system block，不应写入 durable 对话历史。

### 6.5 `AGENTS.md` 的模型可见格式

首版建议使用以下包装格式：

```text
<project-memory source="AGENTS.md" path="AGENTS.md">
...
</project-memory>
```

注意：

1. `path` 应使用 workspace 相对路径，而不是绝对路径。
2. 如果发生截断，应在 block 内显式标明，例如 `[Truncated after 16000 chars.]`。
3. 该包装只用于项目 memory block；现有其他 block 不强制改包装风格。

## 7. Phase 1 正式方案

### 7.1 功能范围

Phase 1 只包含以下能力：

1. 引入 `PromptBundle` 类型与 agent-side `PromptBundleResolver` / 外部 source 依赖。
2. 支持读取 `workspaceRoot/AGENTS.md` 并注入 `memory` block。
3. 让 `ContextBuilder` 使用 agent-side resolver 产出的 `systemBlocks`，而不是继续自己在 builder 内散落拼接完整 system。
4. compact 继续复用 `context.system`，从而自然继承 `AGENTS.md` 和其他 runtime blocks。
5. 为 prompt source 顺序与来源增加测试。

### 7.2 不在 Phase 1 做的能力

1. 不扫描子目录 `AGENTS.md`。
2. 不在 read 工具执行时注入局部 reminder。
3. 不兼容 `CLAUDE.md`。
4. 不开放新的 HTTP API prompt 参数。
5. 不把 `resolveTools()` 迁移进新的 resolver 实现。
6. 不在 Phase 1 引入 `sessionStartBlocks` 或 post-compact session-start 注入。

### 7.3 `AGENTS.md` 发现规则

Phase 1 discovery 规则非常简单：

1. 只检查 `${workspaceRoot}/AGENTS.md`。
2. 不向上查找父目录。
3. 不向下扫描子目录。
4. 文件不存在时，返回空 memory source，不报错。
5. 文件读取失败时，记录日志并退化为空 memory source，不阻塞请求。
6. 文件按 turn live 读取，不做 run-level snapshot。

首版不读取子目录 `AGENTS.md` 的原因是：

1. 当前 runtime 没有“当前活跃文件集合”这个稳定概念。
2. 在没有 path context 的情况下，把多个局部规则盲目拼进每轮 system prompt，反而会引入歧义。
3. 首版应该先把 workspace-level project memory 打通。

### 7.4 `AGENTS.md` 大小与截断策略

Phase 1 引入固定上限：

```text
MAX_PROJECT_MEMORY_CHARS = 16000
```

规则如下：

1. 小于等于上限时，完整注入。
2. 超过上限时，保留前 `MAX_PROJECT_MEMORY_CHARS` 个字符。
3. 在文本尾部追加显式截断提示。
4. 在 `debugSources` 中标记 `truncated: true`。

选择固定上限而不是“完全不限制”的原因是：

1. 项目 memory 本身也是上下文预算的一部分。
2. 首版不应让一个异常巨大的 `AGENTS.md` 直接拖垮所有 turn。
3. 固定上限简单、可预测、易测试。

### 7.5 错误处理策略

对外部 instruction file 的处理应采用 best-effort 策略：

1. 读取失败不应让整次模型请求失败。
2. 缺失文件不应视为错误。
3. 只有解析器本身的编程错误才允许抛出。

这与项目当前“工具失败以结构化结果返回，而非直接让整轮运行崩掉”的风格一致。

### 7.6 compact 语义

Phase 1 对 compact 的要求只有一条：

```text
compact base system = PromptBundle.systemBlocks
compact overlay = compact-specific instruction
```

也就是说：

1. `session-compaction.ts` 不负责重新发现 `AGENTS.md`。
2. `session-compaction.ts` 继续以 `input.context.system` 为 base。
3. `buildCompactionSystemPrompt(...)` 只负责追加 compact overlay。

此外，Phase 1 明确不把 `AGENTS.md` 写进：

1. compact summary message。
2. post-compact synthetic assistant message。

因为 `AGENTS.md` 的正确语义是“每轮重建的 project memory”，不是 compact 后需要回写到 transcript 的工作材料。

## 8. 代码落点与文件职责

### 8.1 `packages/agent/src/context/schema.ts`

需要新增：

1. `PromptSourceDebug`
2. `PromptMemorySource`
3. `PromptBundle`
4. `ContextBuildDebug.promptSources`

目标是：

1. 不改变现有 `ContextSystemBlock` 结构。
2. 让 prompt source debug 与现有 `skippedParts` 一样成为 `BuiltContext.debug` 的一部分。

### 8.2 `packages/agent/src/context/builder.ts`

需要修改：

1. `ContextBuilderDeps` 新增 `listPromptMemorySources(...)` 或等价依赖。
2. `build()` 中不再直接调用当前单一的 `buildSystemContext(...)` 生成最终 system。
3. `build()` 改为调用 agent-side `PromptBundleResolver`，并将 `deps.listPromptMemorySources(...)` 作为其外部输入。
4. `BuiltContext.system` 使用 resolver 产出的 `bundle.systemBlocks`。
5. `BuiltContext.debug.promptSources` 使用 `bundle.debugSources`。

### 8.3 `packages/agent/src/context/system-context.ts`

需要重构职责，而不是继续作为“最终总装配器”。

建议拆成纯 helper：

1. `buildCoreSystemBlock()`
2. `buildEnvironmentSystemBlock()`
3. `buildRuntimeInstructionBlocks()`

这些 helper 仍由 `packages/agent` 提供，因为它们是纯文本构造逻辑，不依赖 server 文件系统。

### 8.4 `packages/agent/src/context/prompt-bundle.ts`

建议新增文件。

职责如下：

1. 在 `packages/agent` 内部定义 `PromptBundleResolver` 或等价纯函数。
2. 接收 core/environment/runtime blocks 与外部 `PromptMemorySource[]`。
3. 按固定顺序产出最终 `PromptBundle`。
4. 维护 `debugSources`。

这一步是修正职责边界的关键：最终 `PromptBundle` 语义仍属于 agent core。

### 8.5 `packages/agent/src/index.ts`

如果 server 侧 prompt resolver 需要复用上述 helper，需要从 package 入口导出它们。

### 8.6 `packages/agent/src/session-compaction.ts`

Phase 1 不要求大改逻辑，但要在代码语义上明确：

1. compact system 以 normal `context.system` 为 base。
2. `buildCompactionSystemPrompt()` 只是 overlay builder。
3. `sessionStartBlocks()` 与 post-compact session-start 能力留到 Phase 2。

### 8.7 `apps/server/src/services/agent/workspace-memory-service.ts`

新增文件。

职责如下：

1. 读取 `${workspaceRoot}/AGENTS.md`。
2. 应用 `MAX_PROJECT_MEMORY_CHARS` 截断策略。
3. 返回结构化 `PromptMemorySource` 数据，而不是直接返回最终 system block。
4. 对文件缺失和读取失败做 best-effort 处理。

建议输出结构：

```ts
type WorkspaceMemorySource = {
  originPath: string;
  relativePath: string;
  text: string;
  truncated: boolean;
  type: 'workspace_agents';
};
```

### 8.8 `apps/server/src/services/agent/prompt-source-service.ts`

新增文件。

它不是最终 `PromptBundle` 的拥有者，而是 server 侧 external source adapter。职责如下：

1. 接收 `session`、`workspaceRoot`、`agentName`、`model`、`lastUserRuntime`。
2. 调用 `workspaceMemoryService` 读取 workspace 级 `PromptMemorySource`。
3. 如未来还有其他 server-owned external memory source，也在这里聚合。
4. 返回 raw memory sources，交由 `packages/agent` 内部的 `PromptBundleResolver` 完成最终拼装。

建议接口：

```ts
listPromptMemorySources(input: {
  agentName: string;
  lastUserRuntime?: MessageRuntimeMetadata;
  model: { modelId: string; providerId: string };
  session: SessionDto;
  sessionId: string;
  workspaceRoot: string;
}): PromptMemorySource[];
```

### 8.9 `apps/server/src/wiring/agent.ts`

需要修改：

1. 在 `buildRunLoopDeps()` 中注入 `listPromptMemorySources`。
2. 保持 `ContextBuilder` 的其他依赖不变。

注意：

1. `SessionCompaction` 本身不需要单独注入 resolver。
2. manual compact 使用的 `ContextBuilder(buildRunLoopDeps())` 会自然得到同一套 prompt bundle。

### 8.10 `packages/agent/src/context/tool-registry.ts`

Phase 1 不改行为。

但需要在 RFC 语义上明确：

1. 工具 prompt 仍属于 tool channel。
2. `resolveTools()` 仍是工具可见性与 description 的主入口。
3. 后续如需引入 `TurnContextResolver`，可以把 `PromptBundle + ResolvedTool[]` 聚合为更高层输出，但首版不强制迁移。

### 8.11 `packages/agent/src/tools/*/prompt.ts`

Phase 1 不改。

当前“每个工具目录自己拥有模型可见描述文案”的结构是正确的，应保留。

## 9. 实现步骤

建议按以下顺序落地。

### 9.1 第一步：引入 `PromptBundle` 与 agent-side resolver

修改：

1. `packages/agent/src/context/schema.ts`
2. `packages/agent/src/context/builder.ts`
3. `packages/agent/src/context/system-context.ts`
4. `packages/agent/src/context/prompt-bundle.ts`
5. `packages/agent/src/index.ts`

完成标志：

1. `ContextBuilder` 不再自己决定完整 system source。
2. 最终 system 顺序与拼装语义仍在 `packages/agent`。
3. external memory source 通过 deps 注入。

### 9.2 第二步：实现 workspace memory discovery

新增：

1. `apps/server/src/services/agent/workspace-memory-service.ts`
2. `apps/server/src/services/agent/prompt-source-service.ts`

完成标志：

1. `workspaceRoot/AGENTS.md` 能以 `memory` block 进入 `PromptBundle`。
2. 文件缺失与读失败可退化。
3. `AGENTS.md` 改动后，下一个 turn 的 build 可看到新内容。

### 9.3 第三步：接线到 runtime

修改：

1. `apps/server/src/wiring/agent.ts`

完成标志：

1. normal turn 自动看到 `AGENTS.md`。
2. manual compact / auto compact 也自动看到同一 base system。

### 9.4 第四步：补测试

新增或修改：

1. `apps/server/src/__tests__/ai-sdk-adapter.test.ts`
2. `apps/server/src/__tests__/run-loop.test.ts`
3. `apps/server/src/__tests__/agent-routes.test.ts`
4. `apps/server/src/__tests__/prompt-source-service.test.ts`
5. `apps/server/src/__tests__/workspace-memory-service.test.ts`

并且应明确：所有直接 `new ContextBuilder(...)` 的调用点都必须同步更新依赖与测试，包括：

1. `packages/agent/src/run-loop.ts`
2. `apps/server/src/services/agent/interaction-service.ts`
3. `apps/server/src/__tests__/ai-sdk-adapter.test.ts`

## 10. 测试计划

### 10.1 prompt source 顺序测试

断言最终 `context.system` 顺序为：

1. core
2. memory
3. environment
4. instruction
5. user_system
6. format

### 10.2 `AGENTS.md` 存在时的注入测试

断言：

1. `systemBlocks` 中存在 `source = 'memory'`。
2. 文本包含 `<project-memory ...>` 包装。
3. `debugSources` 中存在对应 `memory` 来源。

### 10.3 `AGENTS.md` 缺失时的退化测试

断言：

1. 不抛错。
2. `systemBlocks` 只缺失 memory block，其他 block 正常。

### 10.4 大文件截断测试

断言：

1. memory block 文本包含截断提示。
2. `debugSources.truncated === true`。

### 10.5 `AGENTS.md` live read 语义测试

断言：

1. 第一次 build 读取到旧的 `AGENTS.md` 内容。
2. 修改文件后，第二次 build 读取到新的内容。
3. 不需要重建 session 或重启 runtime。

### 10.6 compact 继承 base system 测试

断言：

1. compact request 的 `system` 中同时包含 `AGENTS.md` memory block 与 compact overlay。
2. overlay 仍保留“禁止工具调用”等 compact-specific 规则。

### 10.7 tool channel 不回归测试

断言：

1. `resolveTools()` 行为不因引入 `PromptBundleResolver` 而变化。
2. `toolOverrides` 仍只影响工具暴露，不影响 memory block 顺序。

### 10.8 manual compact 路径测试

断言：

1. manual compact 通过 `interaction-service.ts` 中直接构造的 `ContextBuilder` 仍能正常工作。
2. manual compact 路径也能看到同一套 base system memory block。

## 11. 后续演进

### 11.1 Phase 2：session-start / post-compact 扩展位

`sessionStartBlocks()`、post-compact session-start 注入、以及 `PromptBundle` 中可能的 `sessionStartBlocks` 字段，统一移到 Phase 2 再引入。原因如下：

1. Phase 1 没有真实消费路径。
2. 提前把它放进正式数据模型，会制造“已接通”的错觉。
3. 当前最小闭环只需要 normal turn 与 compact turn 共用同一 base system，不需要额外的 session-start 注入。

### 11.2 Phase 2：read-time 局部 reminder

在 Phase 1 成功后，下一步推荐做的不是“全仓库递归合并多个 `AGENTS.md`”，而是：

1. 当 `read` 工具读取某文件时，向上扫描到 workspace root。
2. 发现最近的局部 `AGENTS.md`。
3. 通过 reminder 形式注入，而不是全局 system blind merge。

这一步更接近 `../opencode` 的 `InstructionPrompt.resolve(...)` 路线。

### 11.3 Phase 3：更高层的 `TurnContextResolver`

如果后续确实需要把 system channel 与 tool channel 在一个 facade 下统一观测，可以引入：

```ts
type TurnContext = {
  prompt: PromptBundle;
  tools: ResolvedTool[];
};
```

但这是更高层的观测与装配抽象，不应阻塞 Phase 1。

### 11.4 Phase 4：更多 source 类型

待后续确认需求后，再考虑：

1. `CLAUDE.md` 兼容。
2. 全局 instruction file。
3. session-level memory。
4. `skill_list` block 真正落地。
5. prompt debug API。

## 12. 备选方案与拒绝理由

### 12.1 方案 A：继续在 `buildSystemContext()` 内直接加 `AGENTS.md` 读取逻辑

拒绝理由：

1. 会让 `packages/agent` 直接依赖文件系统读取。
2. 会破坏当前 runtime core / server wiring 的边界。
3. 后续扩展 memory source 时，`buildSystemContext()` 会继续膨胀。

### 12.2 方案 B：将 `AGENTS.md` 落为 synthetic assistant message

拒绝理由：

1. 语义错误，项目配置不是对话历史。
2. 会污染 transcript 和 compact summary。
3. 会增加重复消息与上下文噪音。

### 12.3 方案 C：首版直接做多层 `CLAUDE.md` / rules / frontmatter path scoping

拒绝理由：

1. 复杂度明显超过当前项目阶段。
2. 当前 runtime 还没有稳定的 path context 供局部规则匹配。
3. 先把 workspace-level memory 打通，更符合最小可用闭环。

### 12.4 方案 D：首版就把 tool channel 也整体迁入新 resolver

拒绝理由：

1. 当前工具系统已经是相对清晰的模块化结构。
2. 立即迁移会扩大改动面，却不能显著提升 Phase 1 的用户价值。
3. 统一不代表必须一次性重写所有通道。

## 13. 决议

本 RFC 的正式决议如下：

1. 本项目采用 `PromptBundleResolver` 路线，而不是继续扩张 `buildSystemContext()`。
2. 首版只支持 workspace 根目录 `AGENTS.md` 作为 `project memory`。
3. `AGENTS.md` 进入 system channel，不写入 transcript。
4. `AGENTS.md` 按 turn live 读取，不做 run-level snapshot。
5. compact 复用 normal turn 的 base system blocks，再叠加 compact overlay。
6. 工具 prompt 继续保留在各工具目录，首版不迁移 tool channel 主链路。
7. 最终 `PromptBundle` 的顺序和装配语义保留在 `packages/agent`；server 只提供 external memory sources。
8. 首版不兼容 `CLAUDE.md`、不做 path-scoped merge、不引入新数据库 schema。

这条路线在复杂度、可实施性和后续扩展空间之间取得了当前项目最合适的平衡：

```text
像 ../opencode 一样有统一装配入口
  +
像 ../claude-code 一样承认 prompt 来源分通道
  -
不把系统一次性做成多层 memory 平台
```
