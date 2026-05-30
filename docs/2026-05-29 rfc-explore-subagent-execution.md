# RFC: 基于本项目的 Explore Subagent 执行链路设计

Status: Proposed

Owner: OpenCode

Last Updated: 2026-05-29

Audience: 人类维护者、coding agent

## 1. 背景

当前项目已经具备一条可运行的单 session agent 主链路：

```text
Composer
  -> SessionInteractionService.prompt()
  -> Lifecycle.startPromptRun()
  -> RunLoop.run()
  -> ContextBuilder.build()
  -> resolveTools()
  -> toAiSdkTurnRequest()
  -> SessionProcessor.processTurn()
  -> ToolExecutor.executePendingToolParts()
```

同时，项目也已经具备一些很适合承接 subagent 的基础：

1. `packages/agent` 已经把 context、run loop、tool execution、approval pause/resume 拆成可组合内核。
2. `apps/server/src/wiring/agent.ts` 已经把 agent core 的副作用能力集中注入到 server services。
3. `SessionRunner` 当前按 `sessionId` 做并发隔离，不同 session 可以并行运行。
4. `nestedAgentsMemoryService` 已经按 `sessionId` 维护路径触发的 `AGENTS.md` 动态注入状态。
5. `MessagePart.type = 'runtime_context'` 已经为局部上下文、目录记忆和后续 specialized runtime signal 预留了稳定落点。

但是，当前项目还没有真正的 subagent 体系，主要缺口如下：

1. 还没有内建 subagent registry。
2. 还没有统一的“启动另一个 agent”的 tool。
3. `SessionDto` / `sessions` 表里还没有 parent-child session 关系。
4. 当前 `resolveTools()` 只看 last-user `toolOverrides` 和少量 variant 特判，不看 agent role。
5. 前端和 server event 侧还没有“从父会话跳到子会话”的产品语义。

用户当前的目标不是一次性做完整的 swarm / team 系统，而是先参考 `../opencode` 的思路，为本项目落一版可用的 `explore` subagent。

本 RFC 的核心选择是：

1. 先只做一个内建 read-only subagent：`explore`。
2. 先做一个统一的 subagent launcher tool，但第一版只允许 `subagentType = 'explore'`。
3. 执行单元采用 child session，而不是把 subagent 塞进父 session 的同一个 run 中。

## 2. 设计输入

### 2.1 当前项目现状

当前与本 RFC 最相关的实现如下：

1. `packages/agent/src/context/builder.ts`
   - 以最后一条 user message 为本轮上下文锚点。
   - 已支持 `runtime_context`、completed/error tool parts 投影进模型上下文。
2. `packages/agent/src/context/system-context.ts`
   - 当前 system prompt 由 `core`、workspace root `AGENTS.md`、runtime mode rules、format 等组成。
3. `packages/agent/src/context/tool-registry.ts`
   - 当前所有 builtin tools 默认可见，仅受 `toolOverrides` 和极少量 schema 特判影响。
4. `packages/agent/src/session-processor.ts`
   - 已能把 model tool calls 持久化为 `MessagePart.type = 'tool'` 和 `tool_calls` durable truth。
5. `packages/agent/src/tool-executor.ts`
   - 已支持同步工具执行、approval pause、tool result 持久化与 SSE 事件追加。
6. `apps/server/src/wiring/agent.ts`
   - 已把 tool 所需的 server side services 通过 `ToolServices` 注入到 agent core。
7. `apps/server/src/services/agent/interaction-service.ts`
   - 当前只支持用户向 session 提交消息，不支持由工具内部拉起 child session。
8. `apps/server/src/services/agent/nested-agents-memory-service.ts`
   - 目录级 `AGENTS.md` 的 read-triggered 注入已经按 session 隔离。

### 2.2 从 `../opencode` 借鉴的点

本 RFC 借鉴 `../opencode` 的四个关键思路：

1. subagent 不是普通消息分支，而是独立的 child session。
2. 主 agent 不直接切换人格，而是通过统一 tool 启动 specialized child agent。
3. subagent 拥有自己的 prompt、自己的工具边界、自己的会话轨迹。
4. 主 agent 最终看到的是 child agent 的摘要结果，而不是整段 child transcript 被原样灌回父上下文。

### 2.3 与当前项目约束的冲突点

直接照搬 `../opencode` 会遇到三类冲突：

1. 当前项目已有 `task_*` 工具体系，不能再复用 `task` 这个名字做 subagent launcher，否则会与 session-level task domain 混淆。
2. 当前项目没有 `subtask` / `agent mention` message part，也没有 parent-child session schema。
3. 当前项目把 `plan/build` 真相收敛在 `runtime.variant`，不能把 `explore` 再错误建模成 `variant`。

因此，本 RFC 不直接复制 OpenCode 的字段和名字，而是保留它的运行心智。

## 3. 目标

本 RFC 的目标如下：

1. 为当前项目落一版只读 `explore` subagent。
2. 让主 session 可以通过统一 tool 启动 `explore` child session。
3. 让 child session 使用独立 prompt、独立工具 allowlist、独立 durable transcript。
4. 让父 session 最终通过 tool result 拿到 `explore` 结果摘要并继续运行。
5. 为后续 `general`、`reviewer` 等 subagent 保留扩展位，但首版不提前实现。
6. 尽量复用现有 `SessionRunner`、`Lifecycle`、`RunLoop`、`SessionProcessor`、`ToolExecutor` 和 SSE 主链路。

## 4. 非目标

本 RFC 首版明确不做以下内容：

1. 不实现通用多 subagent registry 配置系统。
2. 不实现 `general` subagent。
3. 不实现 teammate mailbox、SendMessage、background teammate、owner assignment。
4. 不实现用户在 UI 中直接创建任意 subagent session。
5. 不实现 subagent resume UI。
6. 不实现跨 child session 并发编排和聚合控制台。
7. 不把 `plan/build` 从 `runtime.variant` 重构成完整 agent identity system。
8. 不实现 child session 的用户可见浏览、继续对话或手工恢复入口。

## 5. 核心判断

### 5.1 第一版应该先做 child session，而不是 nested run

当前 `SessionRunner` 的并发边界是“同一个 session 只能有一个 active run”。

如果把 subagent 做成父 session 内的 nested run，会立刻遇到问题：

1. 父 run 与子 run 的 checkpoint/terminal state 会共享一个 `sessionId`。
2. tool event、message event、approval event 难以隔离展示。
3. `nestedAgentsMemoryService`、runtime context message、tool snapshot 等已有 session 级状态会互相污染。

而 child session 天然规避这些问题：

1. 父 session 保持自己的 timeline。
2. 子 session 拥有自己的 messages / tool_calls / approvals / run history。
3. `SessionRunner` 只需保证“每个 session 各跑各的”，不需要推翻当前并发模型。
4. read-triggered nested memory 也会自然按 child session 隔离。

因此，首版推荐继续采用 OpenCode 的 child session 思路。

### 5.2 首版 launcher tool 应命名为 `agent`，而不是 `task`

当前项目已经有：

1. `task_create`
2. `task_get`
3. `task_list`
4. `task_update`
5. `task_stop`

因此不能再像 OpenCode 那样使用 `task` 作为“启动 subagent”的统一工具名。

本 RFC 建议：

1. 新增 builtin tool：`agent`
2. 第一版只允许 `subagentType = 'explore'`
3. 后续如果需要 `general` 等，再在同一个 tool schema 内扩展枚举

这样既保留 OpenCode 的“统一 subagent launcher”心智，又不污染当前项目的 task domain。

### 5.3 `explore` 应通过 `agentName` 建模，而不是 `variant`

当前项目已经明确：

1. `plan/build` 的唯一事实源是 `runtime.variant`
2. `agentName` 保留给将来更丰富的 agent/subagent 概念

因此，`explore` 不应该被做成新的 `variant`。正确建模应为：

1. child session 的 user/assistant message 使用 `agentName = 'explore'`
2. child session 的 launch message 不强制设置 `runtime.variant`
3. `resolveTools()` 和 `buildSystemContext()` 根据 `agentName = 'explore'` 切换专用行为

这样能避免：

1. `variant = plan/build/explore` 这种错误抽象
2. 让 plan/build 行为约束与 subagent 角色混在同一维度

### 5.4 `explore` 的只读特性必须由 runtime hard policy 保证

不能只在 prompt 里写“只读”。

第一版必须做到：

1. 模型在 explore child session 中只看见 `batch`、`read`、`glob`、`grep`
2. `agent` tool 对 explore child session 不可见
3. `bash`、`write`、`edit`、`apply_patch`、`plan_exit`、`task_*` 全部不可见
4. 即使通过 `batch` 组合调用，也不能绕过上述限制

### 5.5 父会话只吃 child summary，不吃 child transcript

本 RFC 明确采用与 OpenCode 相同的上下文隔离判断：

1. child session 全量 transcript 只保存在 child session 自己的 durable history 中
2. 父 session 只通过 `agent` tool 的 result 看到 child summary
3. 不把 child 全部消息回灌成父 session 的 `runtime_context`

这样做的收益是：

1. 父上下文不会被大量搜索噪声污染
2. tool output 压缩更容易做
3. prompt cache 前缀更稳定
4. child durable truth 仍可用于审计、调试和未来扩展

### 5.6 child 完成判定应依赖 child run terminal，而不是额外 done 协议

当前项目已经有统一 run terminal 语义：

1. `completed`
2. `cancelled`
3. `failed`
4. `blocked`
5. `waiting_approval`

`explore` 第一版不应该再引入一个新的“subagent done event”。

正确做法是：

1. `agent` tool 同步等待 child session run 进入 terminal
2. 若 child run `completed`，抽取 child 最后一条 completed assistant message 文本作为结果
3. 若 child run 进入其他 terminal，按 tool error 语义回到父会话

## 6. 总体方案

### 6.1 新增的持久化与共享字段

为支持 child session，建议扩展 `sessions` durable truth 与 `SessionDto`：

```ts
type SessionKind = 'primary' | 'subagent';

type SessionDto = {
  ...
  kind: SessionKind;
  parentSessionId?: string;
  parentToolCallId?: string;
  subagentType?: 'explore';
};
```

推荐对应数据库列：

1. `sessions.kind`
2. `sessions.parent_session_id`
3. `sessions.parent_tool_call_id`
4. `sessions.subagent_type`

首版暂不要求在 `AgentRunDto` 中额外复制这些字段，因为 run 已经通过 `sessionId` 间接关联到 child session。

### 6.2 内建 subagent registry

推荐在 `packages/agent` 中新增一个非常窄的 builtin subagent registry，而不是直接引入通用 config 系统。

建议文件：

1. `packages/agent/src/subagents/builtin.ts`
2. `packages/agent/src/prompt/subagents/explore.ts`

建议数据结构：

```ts
type BuiltinSubagentDefinition = {
  name: 'explore';
  description: string;
  oneShot: boolean;
  allowedTools: ToolName[];
  systemPrompt: string;
};
```

首版只有一个 entry：

```ts
{
  name: 'explore',
  oneShot: true,
  allowedTools: ['batch', 'read', 'glob', 'grep'],
  ...
}
```

### 6.3 Explore 专用提示词

推荐把 `explore` 的 specialized prompt 放在：

1. `packages/agent/src/prompt/subagents/explore.ts`

它不是替代当前 `SYSTEM_PROMPT`，而是在 child explore session 中作为额外的 subagent overlay 注入到 system blocks。

推荐顺序：

1. `core system prompt`
2. workspace root `AGENTS.md`
3. `explore` subagent overlay
4. 其他稳定 session-level system blocks
5. format / userSystem 等运行时块

首版推荐 prompt 基调如下：

```text
You are the Explore subagent for this workspace.

You are a fast, read-only code exploration specialist.

Allowed actions:
- read files
- search paths with glob
- search contents with grep
- use batch only to combine the allowed read/search tools

Forbidden actions:
- do not edit, write, patch, or run shell commands
- do not create or stop tasks
- do not call other agents

Your job is to inspect the codebase and return a concise, evidence-backed report.

When you finish, provide:
1. key findings
2. exact file paths
3. notable code paths or symbols
4. any uncertainty or missing context
```

### 6.4 `agent` tool schema

建议新增 builtin tool：`agent`

首版输入 schema：

```ts
{
  description: z.string().min(1),
  prompt: z.string().min(1),
  subagentType: z.enum(['explore'])
}
```

注意：

1. 首版不支持 `resumeSessionId`
2. 首版不支持 `model` override
3. 首版不支持 background mode
4. 首版不支持 generic custom subagent names

虽然首版是 one-shot，但 tool result 仍然建议把 child `sessionId` 返回给父 tool metadata，主要用于服务端诊断、审计和未来扩展。它不是首版用户可见跳转入口。

建议 outputText 格式：

```text
subagent_session_id: <sessionId>
subagent_type: explore

<explore_result>
...summary text...
</explore_result>
```

建议 payload：

```ts
{
  ok: true,
  subagentSessionId: string,
  subagentType: 'explore',
  summaryText: string,
  childRunId: string
}
```

建议 metadata：

```ts
{
  subagentSessionId: string,
  subagentType: 'explore',
  childRunId: string,
  sessionTitle: string
}
```

### 6.5 `agent` tool 的 server 注入能力

推荐扩展 `ToolServices`，新增一个高层编排入口，而不是让 tool definition 自己拼数据库写入。

建议新增：

```ts
subagentRun?(input: {
  description: string;
  parentRunId: string;
  parentSessionId: string;
  parentToolCallId: string;
  prompt: string;
  subagentType: 'explore';
  workspaceRoot: string;
}): Promise<{
  childRunId: string;
  sessionId: string;
  status: 'completed';
  summaryText: string;
}>;
```

这类高层动作应该放在 server service 层，例如：

1. `apps/server/src/services/agent/subagent-service.ts`

然后在 `apps/server/src/wiring/agent.ts` 的 `buildToolServices()` 中注入。

这个 service 不应复用当前用户 prompt API 的 fire-and-forget 编排，而应提供一个同步等待 child run terminal 的内部方法。推荐语义：

1. service 在事务内创建 child session、child run、child 首条 user message。
2. 事务提交后，直接 `await lifecycle.startPromptRun(...)`。
3. `lifecycle.startPromptRun(...)` 返回后，再读取 child run terminal state 和 child summary。
4. 整个 `subagentRun(...)` 作为一次普通 tool execution 被父 `ToolExecutor.executePart()` await。

原因：

1. 当前 `SessionRunner.ensureRunning()` 是面向用户 prompt API 的 fire-and-forget helper，不适合作为父 tool 的同步等待机制。
2. `agent` tool 需要拿到 child terminal 结果后才能决定自己的 `ToolPresentation`。
3. 首版不需要把 child subagent 暴露成独立的用户可接受 HTTP accepted 任务。

### 6.6 执行时序

第一版完整时序如下：

```text
Parent session run
  -> model emits tool-call: agent
  -> SessionProcessor persists parent tool part + tool_call
  -> ToolExecutor.executePart(agent)
  -> agent tool execute()
  -> subagentService.subagentRun(...)
  -> create child session(kind=subagent, subagentType=explore)
  -> create child user message(agentName=explore, runtime.variant omitted)
  -> create child run
  -> await Lifecycle.startPromptRun(childSessionId)
  -> child RunLoop / SessionProcessor / ToolExecutor
  -> child may call only batch/read/glob/grep
  -> child terminal assistant message completed
  -> extract child summary text
  -> return ToolPresentation to parent tool
  -> parent tool part completed
  -> parent RunLoop enters next step
```

### 6.7 child session 的创建规则

建议 child session 采用以下规则：

1. `workspaceId` 继承父 session
2. `kind = 'subagent'`
3. `parentSessionId = 父 session id`
4. `parentToolCallId = 当前父 toolCallId`
5. `subagentType = 'explore'`
6. `defaultVariant` 继承父 session 的 `defaultVariant`
7. `title` 使用：`<description> (@explore subagent)`
8. `kind = 'subagent'` 的 session 在产品语义上是 internal one-shot session

这里虽然保留 `defaultVariant`，但 launch child 的 user message 不建议写入 `runtime.variant`。原因是：

1. `explore` 的只读语义由 `agentName = 'explore'` 和 allowlist 保证
2. 如果写入 `variant = build`，会把 build overlay 注入 child session，和 explore prompt 混出歧义
3. 如果写入 `variant = plan`，又会把当前项目的 plan file 语义错误带入 explore child

因此，首版建议 `explore` child session 只使用 `agentName` 驱动 specialized prompt 和 tool filter。

额外约束：

1. child session 不提供普通用户继续对话入口。
2. child session 不出现在默认 session list 中。
3. child session 不提供“打开查看 transcript”的前端入口。
4. child session 的 durable truth 主要服务于审计、调试、失败诊断和未来扩展，而不是首版产品可见主路径。

### 6.8 child session 的上下文组成

child explore session 仍然复用现有 `ContextBuilder`，但有三点区别：

1. 最后一条 user message 的 `agentName = 'explore'`
2. `resolveTools()` 在看到 `agentName = 'explore'` 时，只暴露 `batch`、`read`、`glob`、`grep`
3. `buildSystemContext()` 在看到 `agentName = 'explore'` 时，插入 explore overlay

因此 explore child 仍能自动获得：

1. root `AGENTS.md`
2. 环境/稳定 system blocks
3. 目录级 `AGENTS.md` 动态注入
4. 自己运行过程中产生的 read results 与 file snapshots

但它不会看到：

1. 父 session 的全部 transcript 被原样复制
2. 父 session 的 task board / approval noise
3. 父 session 的 build-mode 执行约束被错误混入
4. 父 session 已有的 read results / file snapshots 被自动继承

### 6.9 `resolveTools()` 与 batch child 过滤

建议把 `resolveTools()` 改成三段过滤：

```text
builtin registry
  -> subagent allowlist filter
  -> existing variant/toolOverrides adjustments
  -> final enabled tools
```

具体规则：

1. 当 `agentName !== 'explore'` 时，保持现有行为。
2. 当 `agentName === 'explore'` 时，只允许：
   - `batch`
   - `read`
   - `glob`
   - `grep`
3. `toolOverrides` 在 explore child 中只能继续缩小，不得扩大。
4. `batch` 不能成为 explore 越权入口。

首版对 `batch` 的具体处理要求应写死为：

1. `SessionProcessor.persistBatchToolCall()` 在展开 batch child calls 时，必须根据当前 request 的 enabled tool policy 过滤 child tool。
2. 若某个 child tool 不在当前 agent/session 的 enabled tool set 中，直接静默剔除，不报错，不创建 tool part，不创建 tool_call。
3. 只有过滤后的 child 集合继续参与 batch group plan。
4. 若过滤后 child 集合为空，则将 outer batch 视为成功但空执行：
   - 不创建任何 child tool parts
   - outer batch result 文本应提示该批次没有可执行 child tools
5. `batch` 的提示词也应更新，避免在 explore child 中继续暴露“文件修改、shell、task 更新可进入 batch”的文案。

这样做的原因是：

1. 现有 `batch` child schema 允许任意 `tool: string`。
2. 仅依赖后续 `ToolExecutor` 或 approval mode 检查，不足以表达“当前 agent 看不见的 tool 根本不应进入 durable transcript”。
3. 静默剔除比直接报错更符合首版 explore 的产品预期：尽量完成合法探索，不因为混入非法 child 就把整批调用打成失败。

### 6.10 child summary 的抽取规则

child run `completed` 后，server 需要抽取一个稳定 summary 返回给父 tool。

首版建议：

1. 读取 child session 最后一条 `role = 'assistant' && status = 'completed'` 的 message
2. 把其中所有 `text` part 按顺序拼接为 `summaryText`
3. 若没有可用 text，则返回错误

不建议首版要求 child 走额外 structured output schema。原因是：

1. 当前项目的主链路已能稳定处理普通 assistant text
2. 先让 explore 返回文字报告，更容易复用已有 timeline / SSE / compact 语义
3. structured output 可以留到后续 `general` 或 richer subagent 版本再引入

### 6.11 完成与失败语义

`agent` tool 的成功条件：

1. child run terminal status = `completed`
2. 成功抽取到 `summaryText`

`agent` tool 的失败条件：

1. child run terminal status = `failed`
2. child run terminal status = `cancelled`
3. child run terminal status = `blocked`
4. child run 进入 `waiting_approval`
5. child run `max_steps_exceeded`
6. child run `context_too_large`
7. child terminal 后无法抽取 summary

失败时建议行为：

1. `subagentRun(...)` 抛出错误
2. `ToolExecutor.executePart()` 会把父 tool part 记为 `state.status = 'error'`
3. 父 run 不直接崩溃，而是在下一轮把这个 tool error 作为上下文暴露给模型

这与当前项目其他 tool 的失败传播方式一致。

### 6.12 approval 语义

`explore` 首版不应触发 approval。

原因：

1. 可见工具只剩 `batch`、`read`、`glob`、`grep`
2. 这些工具本身都应是 `approval = 'never'`

如果因为实现错误导致 explore child 出现 `waiting_approval`，应视为 bug，而不是合法产品路径。首版直接将其视为 tool failure 返回给父 session。

### 6.13 SSE 与前端展示

第一版不需要给父 session 追加新的专用 `subagent.*` 事件类型。

现有事件 already 足够：

1. parent session 会收到自己的 `message.part.updated` / `tool.completed` / `tool.failed`
2. child session 在 durable event 层仍会产生自己完整的 `run.*`、`message.*`、`tool.*` 流

因此前端最小展示方案应进一步收窄为：

1. parent timeline 中，`agent` tool part 作为一张普通 tool card 渲染
2. 该 tool card 只展示 `subagentType`、完成状态、摘要文本和可选调试标识
3. 不提供 “Open explore session” 入口

首版不要求：

1. session list 中自动树形展示 parent/child
2. child session 间循环导航
3. 在父 stream 中实时镜像 child transcript
4. child session 的用户可见详情页

### 6.14 与 nested agents memory 的关系

当前 `nestedAgentsMemoryService` 已经是 session-scoped。

这对 child session 方案非常友好：

1. explore child 自己读到的文件，只会触发 child session 的目录级 `AGENTS.md` 注入
2. 父 session 不会因为 child 的读路径而污染自己的 runtime context
3. compact 时 child session 的 nested memory 也能独立清理

因此首版不需要为 nested memory 再做额外特殊处理。

## 7. 需要改动的模块

### 7.1 `packages/shared`

建议改动：

1. `ToolName` 新增 `agent`
2. `SessionDto` 新增：
   - `kind`
   - `parentSessionId?`
   - `parentToolCallId?`
   - `subagentType?`
3. 对应 contracts/schema 补充 `SessionKind` / `SubagentType`

### 7.1.1 `packages/orm` / migration

建议补充：

1. `sessions` 表新增：
   - `kind`
   - `parent_session_id`
   - `parent_tool_call_id`
   - `subagent_type`
2. `tool_calls.tool_name` check constraint / enum 白名单加入 `agent`
3. 对应 Drizzle schema、relations、SQL migration 一并更新

### 7.2 `packages/agent`

建议改动：

1. 新增 `agent` tool definition
2. 新增 builtin subagent registry
3. `buildSystemContext()` 支持 `agentName = 'explore'` prompt overlay
4. `resolveTools()` 支持 subagent allowlist filter

### 7.3 `apps/server`

建议改动：

1. 新增 `subagent-service.ts`
2. `buildToolServices()` 注入 `subagentRun()`
3. session repository / service 支持 child session 字段
4. session 查询默认过滤 internal subagent sessions，避免它们直接出现在普通用户会话列表中

### 7.4 `apps/web`

建议改动：

1. parent tool card 识别 `toolName = 'agent'` 且 `metadata.subagentType = 'explore'`
2. 不渲染 child session 跳转入口
3. 只把 child 结果展示成父 tool summary，不新增 child transcript 查看 UI

## 8. 第一版建议的交付边界

首版建议明确收窄到以下范围：

1. 只有一个 builtin subagent：`explore`
2. 只有一个 launcher tool：`agent`
3. 只支持 one-shot explore，不支持 resume input
4. child session 是 internal one-shot durable object，不对用户暴露查看或继续对话入口
5. 父 session 只拿到 child summary，不实时镜像 child stream

这样可以尽快验证三件事：

1. child session 方案是否与当前 run/event/tool 主链路兼容
2. specialized prompt + allowlist 是否足以让 explore 稳定只读
3. 父子 session 分离是否能显著改善上下文噪声与可回放性

## 9. 后续扩展位

若 explore 第一版稳定，后续可按同一骨架继续扩展：

1. `general` subagent
2. 在明确产品需要后，再评估是否开放 `resumeSessionId` / `subagentSessionId` 继续同一 child session
3. session list 中的 parent/child 导航或内部调试查看
4. child summary 的结构化输出
5. 通用 config-driven subagent registry

但这些都不应阻塞 explore 第一版。

## 10. 一句话结论

基于当前项目现状，最贴近 OpenCode、同时又最不破坏现有主链路的方案是：

1. 新增一个统一的 `agent` tool
2. 第一版只允许启动 `explore`
3. `explore` 在独立 child session 中运行
4. child session 通过 `agentName = 'explore'` 获得专用 prompt 和只读工具集合
5. 父会话通过 tool result 只拿到 child summary，并继续自己的 run loop

这就是本项目第一版 `explore` subagent 的推荐落地方式。
