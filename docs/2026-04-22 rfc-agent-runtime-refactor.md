# RFC: Session Runtime 分层重构方案

Status: Proposed

Owner: OpenCode

Last Updated: 2026-04-22

## 1. 目标

这份文档不是泛泛的重构建议，而是给后续 agent 直接实施的执行型 RFC。

本次重构的核心目标是：

1. 借鉴 `../opencode` 的 `SessionPrompt.prompt()`、per-session runner、`runLoop()`、`SessionProcessor` 分层方式。
2. 借鉴 `../claude-code` 的 async lifecycle 包装层，但不照搬它的 transcript-first runtime。
3. 保留当前项目已经跑通的关键行为：
   - OpenAI Responses API
   - `previous_response_id` checkpoint 恢复
   - approval pause/resume
   - SQLite 为真源
   - SSE replay + live
4. 把当前 `apps/server/src/agent/runtime.ts` 中混在一起的职责拆开，但不改变外部 API 行为。
5. 在 `SessionProcessor` 分层时，受控引入更细粒度的 `MessagePart` 建模，为后续 richer transcript / detail UI 打基础。

## 2. 非目标

本 RFC 明确不做以下事情：

1. 不切换 provider，不放弃 `previous_response_id` 恢复方案。
2. 不把 runtime 改成 transcript-first 重建模型输入的架构。
3. 不引入 `Effect`、`Bus`、`MessageV2.Part` 那整套 `opencode` 技术栈。
4. 不改变现有 `SessionEvent` / SSE 协议语义。
5. 不一次性照搬 `opencode` 的完整 part 体系，不引入与当前链路不匹配的细粒度 part 状态机。
6. 不要求前端在本次重构里立刻完整消费所有新增 part 类型。
7. 不修改前端对现有事件协议的依赖。

## 3. 当前问题

当前运行链路已经可用，但 `apps/server/src/agent/runtime.ts` 承担了过多职责。

### 3.1 当前 runtime 同时负责的内容

1. 用户消息入口。
2. 审批入口。
3. session active run 互斥。
4. 后台 detached run 生命周期。
5. OpenAI stream orchestration。
6. assistant message 懒创建与文本 delta 落库。
7. tool call 状态机。
8. approval 创建与恢复。
9. checkpoint 更新。
10. 失败映射与 session 状态更新。

### 3.2 当前结构的问题

1. orchestration、processor、lifecycle 混在一个文件里，后续继续长会变得难以测试。
2. `activeRuns: Set<string>` 只能表达“忙/闲”，无法自然扩展到 cancel、paused、queued 等运行态。
3. 文本流处理、tool 分支、approval 分支散在多个函数里，缺少统一的 turn result 协议。
4. detached run 的失败处理和 run 本体耦合，无法像 `claude-code` 那样单独演进 lifecycle。

## 4. 借鉴来源与采纳边界

### 4.1 采纳 `../opencode` 的内容

主要采纳以下架构思想：

1. `SessionPrompt.prompt()` 负责 session 入口，而不是让 route 直接进入大 runtime。
2. 用 per-session `SessionRunner` 表达运行态和互斥，而不是只用一个 `Set<string>`。
3. 用 `runLoop()` 只负责 turn orchestration。
4. 用 `SessionProcessor` 只负责“流事件 -> 持久化状态/事件”的转换。

明确不采纳的内容：

1. 不引入 `Effect`。
2. 不引入 `MessageV2` / part store 的整套消息模型。
3. 不引入 `Bus` 作为主要状态真源。

### 4.2 采纳 `../claude-code` 的内容

主要采纳以下架构思想：

1. 把 async/background 生命周期包装层与 query loop 分离。
2. 让 lifecycle 层负责 detached run、终态映射、cleanup，而不是让 loop 直接承担这些责任。
3. 使用明确的 terminal reason / transition reason 帮助调试和测试。

明确不采纳的内容：

1. 不使用 transcript-first resume。
2. 不把 transcript sidechain 持久化引入本项目 runtime。
3. 不迁移到 CLI/subagent runtime 语义。

## 5. 当前链路

当前主链路如下：

```text
Route
  -> AgentLoop
  -> AgentRuntime.submitUserMessage() / resolveApproval()
  -> AgentRuntime.executeLoop()
  -> streamModelResponse()
  -> AgentRuntime 内部直接处理 delta / tool call / approval / checkpoint
  -> sessionEventService.append(...)
  -> sessionStreamHub.publish(...)
  -> SSE route 输出给前端
```

### 5.1 当前入口函数

1. `apps/server/src/routes/agent/agent.handler.ts`
2. `apps/server/src/routes/approvals/approvals.handler.ts`
3. `apps/server/src/agent/loop.ts`
4. `apps/server/src/agent/runtime.ts`

### 5.2 当前 runtime 中承担的关键函数

1. `submitUserMessage()`
2. `resolveApproval()`
3. `executeLoop()`
4. `executeFunctionCall()`
5. `resumeFromApproval()`
6. `startDetachedRun()`
7. `handleDetachedRunFailure()`

## 6. 目标链路

重构后的目标链路如下：

```text
Route
  -> AgentLoop
  -> SessionPromptService.prompt() / resolveApproval()
  -> SessionRunner.ensureRunning(setup, run)
  -> Lifecycle.startPromptRun() / resumeApprovalRun()
  -> RunLoop.run(...)
  -> SessionProcessor.processTurn(...)
  -> model-client stream
  -> SessionProcessor 持久化 message/tool/approval/checkpoint/event
  -> sessionEventService.append(...)
  -> sessionStreamHub.publish(...)
  -> SSE route 输出给前端
```

### 6.1 关键变化

1. route 不再直接把业务入口打进大 runtime。
2. `runtime.ts` 将被拆成多个稳定职责文件。
3. `RunLoop` 不再自己同时充当 lifecycle 和 processor。
4. session 级互斥将由 `SessionRunner` 管理。
5. detached run 的包装将由 `Lifecycle` 负责。

## 7. 目标模块结构

建议结构如下：

```text
apps/server/src/agent/
  checkpoint.ts
  lifecycle.ts
  loop.ts
  model-client.ts
  run-loop.ts
  runner.ts
  session-processor.ts
  tool-executor.ts

apps/server/src/services/session/
  message-service.ts
  session-event-service.ts
  session-prompt-service.ts
  session-service.ts
```

### 7.1 每个新模块的职责

#### `services/session/session-prompt-service.ts`

负责 session 级入口，不直接处理模型流。

职责：

1. `prompt()`：创建 user message，更新 session 状态，启动后台 run。
2. `resolveApproval()`：更新 approval/tool_call 决策状态，并触发恢复运行。
3. 作为 route 层真正依赖的应用服务。

#### `agent/runner.ts`

负责 per-session active execution 锁与完整锁生命周期。

职责：

1. `ensureRunning(sessionId, setup, run)`
2. `busy(sessionId)`
3. 预留 `cancel(sessionId)`

本阶段不需要复制 `opencode` 完整的 `Shell | ShellThenRun` 状态，但必须从 `Set<string>` 升级到“`SessionRunner` 自己掌握 acquire/setup/run/release 全生命周期”的 API。

`SessionRunner` 本阶段明确只表达“当前 session 是否存在 active background execution”。

说明：

1. `waiting_approval` 不是 runner 内存态，而是 `sessions.status + checkpoint` 的持久化业务状态。
2. runner 不持有 `approvalId`、`toolCallId` 这类业务字段。
3. session paused for approval 时，runner 应回到 idle，而不是继续持锁。

建议 API：

```ts
class SessionRunner {
  async ensureRunning<T>(
    sessionId: string,
    setup: () => Promise<T>,
    run: (ctx: T) => Promise<void>
  ): Promise<T>;

  busy(sessionId: string): boolean;
}
```

建议语义：

1. 先拿锁，再执行 `setup()`。
2. `setup()` 失败则立即释放锁。
3. `setup()` 成功后启动后台 `run(ctx)`。
4. `run(ctx)` 完成、失败或 pause-return 后都由 runner 自动释放锁。
5. 调用方不负责释放锁。

#### `agent/run-loop.ts`

负责 turn orchestration，不直接感知 HTTP，不直接承担 detached lifecycle。

职责：

1. 驱动 `while (true)` turn loop。
2. 调用 `SessionProcessor.processTurn()`。
3. 根据 processor 返回值决定是完成、暂停还是继续下一轮。
4. 维护 `currentInput` 与 `previousResponseId`。

#### `agent/session-processor.ts`

负责单轮 assistant turn 的流事件处理和状态落库。

职责：

1. 懒创建 assistant message。
2. 处理文本 delta 并发 `message.delta`。
3. 处理 function call。
4. 创建 tool_call / approval / tool result message。
5. 更新 checkpoint。
6. 在允许的范围内生成更细粒度 `MessagePart`。
7. 产出结构化 `ProcessorResult` 给 `RunLoop`。

#### `agent/lifecycle.ts`

负责 detached/background run 的生命周期包装。

职责：

1. `startPromptRun()`
2. `resumeApprovalRun()`
3. 仅把无法恢复的 runtime / lifecycle 异常映射到 `session.failed` 与 `session.status=failed`
4. 统一 cleanup
5. 预留 metrics / tracing / cancel hook

### 7.2 保持不变的模块

以下模块继续保留，但被新分层复用：

1. `agent/model-client.ts`
2. `agent/tool-executor.ts`
3. `agent/checkpoint.ts`
4. `services/session/session-event-service.ts`
5. `internal/realtime/session-stream-hub.ts`
6. `internal/realtime/sse.ts`

## 8. 受控的 `MessagePart` 扩展

本次重构允许引入更细粒度的 `MessagePart` 建模，但必须是受控范围，不追求一次性复制 `opencode` 的完整 part store。

### 8.1 为什么要加

原因：

1. `SessionProcessor` 天然就是“流事件 -> 持久化消息结构”的边界层。
2. 当前 `MessagePart` 只有 `text` 和 `tool_result`，对后续 richer transcript / detail pane 扩展空间太小。
3. 如果继续只保留粗粒度 `text`，后面再拆 reasoning / patch / summary 会再次触发 shared type 和持久化结构调整。

### 8.2 本次允许的 part 类型

本次允许扩展为如下方向：

```ts
type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_result'; toolName: string; content: unknown }
  | {
      type: 'patch';
      files: Array<{
        path: string;
        change: 'create' | 'update' | 'delete';
      }>;
    }
  | {
      type: 'summary';
      text: string;
      source: 'system' | 'assistant' | 'compaction';
    };
```

说明：

1. 这是目标范围，不要求一次性在第一步全部产出。
2. 本次不要求引入 `tool_call_input_start`、`step_start`、`step_finish` 这类更细颗粒的内部事件 part。
3. 如果实现过程中发现某种 part 缺少稳定来源，可以先扩 shared type，但必须与现有消费者的类型兼容适配同一步完成，不能只改 `MessagePart` 联合类型而不更新消费端。
4. “先扩 schema、后开启发射” 的两阶段，指的是“schema + consumers ready”与“runtime emission”两阶段，而不是“先只改 shared type，后面再补消费者”。

### 8.3 本次建议的生成策略

建议：

1. `text`
   - 继续作为 assistant 最主要输出。
   - 继续复用现有 `message.delta` / `message.completed`。
2. `reasoning`
   - 只有在 provider 流事件能稳定拿到 reasoning 内容时才生成。
   - 如果当前 provider/SDK 不能稳定提供，允许暂不实现实际生成。
3. `patch`
   - 只在系统能稳定得出变更文件集合时生成。
   - 对 `write_file` 可以优先考虑；对 `run_command` 不应伪造 patch part。
4. `summary`
   - 作为预留类型可以先进入 shared type。
   - 如果本阶段没有 compaction / summarization 生成逻辑，允许不实际写入。

### 8.4 本次明确不做的 part 行为

1. 不为所有 part 类型都新增 SSE delta 事件。
2. 不要求前端立刻为所有 part 类型实现完整展示。
3. 不把 message part 细化扩展到 `MessageV2.Part` 那种粒度。
4. 不为了生成 patch part 额外引入复杂 snapshot / diff 子系统。

### 8.5 实施原则

1. part 类型扩展必须与 `SessionProcessor` 重构一起落地，而不是先散落到 runtime 各处。
2. 先保证 runtime 分层，再增加 part 生成逻辑；不要反过来。
3. 不能稳定生成的 part 可以先不写入，不能用猜测数据填充。
4. 新增 part 类型要分两步推进：第一步扩 shared `MessagePart` 并同步更新所有现有类型检查消费者；第二步在相关消费者具备展示或降级策略后，再开启 runtime 对新 part 的实际写入。
5. 在第一步完成前，不允许单独提交只修改 `MessagePart` 联合类型的变更。
6. 在第二步开启前，运行时对外实际写入的 part 仍应限制在 `text` / `tool_result`。

## 9. 目标调用链详解

这一节按链路顺序说明每一层重构后应该做什么。

### 9.1 `POST /api/sessions/:sessionId/messages`

目标调用链：

```text
agent.handler.ts
  -> AgentLoop.submitUserMessage()
  -> SessionPromptService.prompt()
  -> SessionRunner.ensureRunning(setup, run)
```

`SessionPromptService.prompt()` 应做：

1. 验证 session 是否存在。
2. 验证 session 当前是否允许提交。
3. 通过 `runner.ensureRunning(sessionId, setup, run)` 进入运行 admission。
4. `setup()` 中创建 user message。
5. `setup()` 中发 `message.created`。
6. `setup()` 中更新 session 为 `executing`。
7. `setup()` 中发 `session.updated`。
8. `run(ctx)` 中调用 `Lifecycle.startPromptRun()` 启动后台 run。
9. 返回 `SubmitSessionMessageResponse`。

这一步明确借鉴 `opencode` 的 `SessionPrompt.prompt()`，但保留当前 web 异步响应模型。

说明：

1. admission 必须先于 DB 写入发生。
2. 这能避免并发请求下写出幽灵 user message。
3. 这也能保证 setup 失败时 runner 立即释放锁。

### 9.2 `Lifecycle.startPromptRun()`

目标调用链：

```text
SessionPromptService.prompt()
  -> SessionRunner.ensureRunning(sessionId, setup, run)
  -> Lifecycle.startPromptRun()
  -> RunLoop.run(...)
```

`Lifecycle` 在这一步负责：

1. 包装 detached run。
2. 捕获异常并转成 `session.failed`。
3. 负责 prompt run 的 terminal reason 映射。
4. 保证 lifecycle 行为不污染 `RunLoop`。

说明：

1. `SessionRunner` 负责 acquire/release 锁。
2. lifecycle 不再感知锁。
3. lifecycle 只负责后台执行包装与失败收口。

这一步明确借鉴 `claude-code` 的 `runAsyncAgentLifecycle()` 思路。

### 9.3 `RunLoop.run()`

目标调用链：

```text
Lifecycle
  -> RunLoop.run({ sessionId, input, previousResponseId })
  -> SessionProcessor.processTurn(...)
```

`RunLoop.run()` 应只做：

1. 初始化 `currentInput`。
2. 初始化 `previousResponseId`。
3. `while (true)` 调 `SessionProcessor.processTurn()`。
4. 根据 `ProcessorResult.kind` 决定：
   - `completed`
   - `continue_with_tool_results`
   - `paused_for_approval`
5. 绝不直接操作 approval repository 或 message repository。

### 9.4 `SessionProcessor.processTurn()`

目标调用链：

```text
RunLoop
  -> SessionProcessor.processTurn()
  -> streamModelResponse()
  -> for await event of stream
```

这一步是本次重构的核心。

`SessionProcessor` 应承担：

1. 创建或懒创建 assistant message。
2. 处理 `response.output_text.delta`。
3. 更新 message content。
4. 发 `message.delta` / `message.completed`。
5. 从 `finalResponse.output` 提取 function calls。
6. 决定：
   - 无 function call -> `completed`
   - auto tool -> `continue_with_tool_results`
   - approval tool -> `paused_for_approval`

### 9.5 `resolveApproval()` 恢复链路

目标调用链：

```text
approvals.handler.ts
  -> AgentLoop.resolveApproval()
  -> SessionPromptService.resolveApproval()
  -> SessionRunner.ensureRunning(setup, run)
  -> Lifecycle.resumeApprovalRun()
  -> RunLoop.run(...)
```

`SessionPromptService.resolveApproval()` 应承担：

1. 加载 approval 与 tool_call。
2. 校验状态是否合法。
3. 通过 `runner.ensureRunning(sessionId, setup, run)` 进入恢复 admission。
4. `setup()` 中持久化 approval 决策。
5. `setup()` 中发 `approval.resolved`。
6. `setup()` 中更新 session 为 `executing`。
7. `setup()` 中发 `session.updated`。
8. `run(ctx)` 中触发 `Lifecycle.resumeApprovalRun()`。

具体的工具执行和 `function_call_output` 组装不应再由入口层直接处理。

明确约定：

1. `Lifecycle.resumeApprovalRun()` 负责读取 checkpoint。
2. `Lifecycle.resumeApprovalRun()` 在 approval `approved` 且工具执行成功时，负责持久化 tool result、发 `tool.completed`，并继续模型。
3. `Lifecycle.resumeApprovalRun()` 在 approval `approved` 但工具执行失败时，仍必须持久化失败 tool result、发 `tool.failed`，并把错误 payload 组装成 `function_call_output` 继续模型；这类工具失败不能直接升级成 `session.failed`。
4. `Lifecycle.resumeApprovalRun()` 在 approval `rejected` 时，负责构造 synthetic tool result 并继续模型。
5. `Lifecycle.resumeApprovalRun()` 负责把 `function_call_output[]` 作为 `RunLoop.run()` 的 `initialInput`。

## 10. 新的结果协议

为了避免当前 `runtime.ts` 中 scattered return 分支，必须为 `RunLoop` 和 `SessionProcessor` 定义清晰结果协议。

### 10.1 `ProcessorResult`

建议：

```ts
type ProcessorResult =
  | {
      kind: 'completed';
      previousResponseId: string;
    }
  | {
      kind: 'continue_with_tool_results';
      nextInput: ResponseInputItem[];
      previousResponseId: string;
    }
  | {
      kind: 'paused_for_approval';
      checkpoint: SessionCheckpoint;
      previousResponseId: string;
    };
```

### 10.2 `RunLoopResult`

建议：

```ts
type RunLoopResult =
  | {
      kind: 'completed';
      previousResponseId: string;
    }
  | {
      kind: 'paused_for_approval';
      checkpoint: SessionCheckpoint;
      previousResponseId: string;
    };
```

说明：

1. `RunLoop` 只返回它自己能正常收口的终态，不负责表达 `failed`。
2. `continue_with_tool_results` 只存在于 `ProcessorResult`，不会成为 `RunLoop` 的最终返回值。

### 10.3 `LifecycleResult`

建议：

```ts
type LifecycleTerminalReason = RunLoopResult['kind'] | 'failed';

type LifecycleResult = {
  reason: LifecycleTerminalReason;
};
```

说明：

1. 参考 `claude-code` 的 `transition reason` 思路。
2. 当前版本不必把所有原因都持久化，但内部日志与测试必须能区分这些终态。

## 11. 与现有实现的映射关系

### 11.1 从 `runtime.ts` 移出的职责

#### 移到 `session-prompt-service.ts`

1. `submitUserMessage()` 的前半段。
2. `resolveApproval()` 的前半段。
3. user message 创建与初始 session 状态更新。

#### 移到 `run-loop.ts`

1. `executeLoop()` 的主 while 结构。
2. `currentInput` 与 `previousResponseId` 推进。

#### 移到 `session-processor.ts`

1. `ensureAssistantMessage()`。
2. 文本 delta 落库。
3. `createToolResultMessage()`。
4. `executeFunctionCall()` 的核心分支逻辑。
5. tool call / approval / checkpoint 事件映射。

#### 移到 `lifecycle.ts`

1. `startDetachedRun()`。
2. `handleDetachedRunFailure()`。
3. `resumeFromApproval()` 的外围包装逻辑。
4. 审批恢复时的工具执行与 `function_call_output` 初始输入组装。

#### 移到 `runner.ts`

1. `activeRuns`。
2. `reserveRun()`。
3. `releaseRun()`。
4. “先 admission，再 setup，再后台 run，再统一 release”的完整锁生命周期。

## 12. 实施约束

为了降低重构风险，后续 agent 在实施时必须遵守以下约束：

1. 路由层外部行为不得改变：
   - `POST /messages` 仍返回 `202`
   - SSE 协议不变
   - approval 路由不变
2. `previous_response_id` checkpoint 恢复策略不得改变。
3. approval pause/resume 语义不得改变。
4. `SessionEvent` 类型和现有前端消费方式不得被破坏。
5. 新增 `MessagePart` 类型不能破坏现有 `text` / `tool_result` 消费链路。
6. 扩 `MessagePart` union 时，必须同步更新所有现有类型检查消费者，确保 `pnpm typecheck` 不会因为联合类型扩大而失败。
7. 在相关消费者更新前，不允许向真实消息中发射新的非 `text` / `tool_result` part。
8. `pnpm typecheck`、`pnpm lint`、`pnpm build` 和现有 server tests 必须全通过。

## 13. 推荐实施顺序

必须按以下顺序推进，避免一次性大改主链路：

1. 引入 `runner.ts`，用它替代 `activeRuns: Set<string>`，不改行为。
2. 新增 `session-prompt-service.ts`，把 route 入口逻辑迁出去，不改 loop 本体。
3. 新增 `run-loop.ts`，把 `executeLoop()` 抽出去，不改行为。
4. 新增 `session-processor.ts`，把流事件处理和 tool/approval 分支迁出去。
5. 在 `SessionProcessor` 稳定后，扩展受控 `MessagePart` 类型与生成逻辑。
6. 新增 `lifecycle.ts`，把 detached run 和恢复生命周期包装抽出去。
7. 最后瘦身 `runtime.ts` 或让其退化为 facade。

## 14. 验收标准

重构完成至少满足：

1. 新消息提交仍能创建 user message，并通过 SSE 实时看到 assistant 文本流。
2. `read_file` 仍能自动执行并继续模型。
3. `write_file` / `run_command` 仍会创建 approval 并暂停。
4. approval 通过后仍能继续同一个 `previous_response_id` 会话。
5. approval 通过后，即使工具执行失败，仍会继续同一个 `previous_response_id` 会话，并把错误 payload 交回模型。
6. approval 拒绝后仍能继续模型并给出替代响应。
7. 页面刷新后 SSE replay 仍正确工作。
8. 如果已扩展 `MessagePart`，现有 `text` / `tool_result` 路径继续正确工作。
9. 新增重构代码后，现有 server tests 继续通过。

## 15. 文档后的明确任务

以下任务允许后续 agent 逐项实施。

Task【1】引入 `agent/runner.ts`

目标：

1. 把 `activeRuns: Set<string>` 从 `runtime.ts` 中移除。
2. 引入“先 admission，再 setup，再后台 run，再统一 release”的 per-session runner。
3. 保持行为与当前一致。

输出：

1. `apps/server/src/agent/runner.ts`
2. 相关调用方改为依赖 runner

Task【2】引入 `services/session/session-prompt-service.ts`

目标：

1. 把 route 入口逻辑从 `runtime.ts` 迁出。
2. `prompt()` / `resolveApproval()` 成为真正的 session 应用服务入口。

输出：

1. `apps/server/src/services/session/session-prompt-service.ts`
2. `loop.ts` 与 routes 依赖新 service

Task【3】引入 `agent/run-loop.ts`

目标：

1. 把当前 `executeLoop()` 抽成独立 orchestration 模块。
2. 明确 `RunLoopResult`。

输出：

1. `apps/server/src/agent/run-loop.ts`
2. `runtime.ts` 不再直接持有主 while loop

Task【4】引入 `agent/session-processor.ts`

目标：

1. 把文本 delta、tool call、approval 分支从 `runtime.ts` 中抽出。
2. 明确 `ProcessorResult`。
3. 保持现有 message/tool/approval/session_event 语义不变。
4. 让后续更细粒度 `MessagePart` 生成具备稳定落点。

输出：

1. `apps/server/src/agent/session-processor.ts`
2. `run-loop.ts` 调用 `SessionProcessor.processTurn()`

Task【5】扩展受控 `MessagePart` 建模

目标：

1. 扩展 shared `MessagePart` 类型，支持 `reasoning` / `patch` / `summary` 的受控引入。
2. 优先为当前链路中能稳定生成的数据落 part，不强造不稳定 part。
3. 保持现有前端对 `text` / `tool_result` 的消费不被破坏。
4. 将“schema 扩展 + 现有消费者兼容”和“真实发射新 part”拆成两个阶段，禁止只改 shared type 而不更新消费端，也禁止一步到位打开全部新 part 发射。

输出：

1. `packages/shared/src/dto.ts` 更新后的 `MessagePart`
2. `repositories/message-repository.ts` 与相关服务兼容新 part
3. `SessionProcessor` 内稳定的 part 生成逻辑
4. 对现有消费者的兼容性检查或适配更新

Task【6】引入 `agent/lifecycle.ts`

目标：

1. 把 detached run、failure mapping、resume wrapper 从 `runtime.ts` 中抽出。
2. 形成类似 `claude-code` 的 async lifecycle 包装层，但保留当前 DB + SSE 架构。

输出：

1. `apps/server/src/agent/lifecycle.ts`
2. 统一的后台 run 启动与失败处理入口

Task【7】补 runtime 分层后的测试

目标：

1. 为 `SessionRunner`、`RunLoopResult`、`SessionProcessor`、`Lifecycle` 增加测试。
2. 覆盖：
   - 普通文本轮次
   - auto tool 轮次
   - approval pause 轮次
   - approval resume 轮次
   - detached failure 映射

输出：

1. 新增/更新 `apps/server/src/__tests__/` 下相关测试文件
