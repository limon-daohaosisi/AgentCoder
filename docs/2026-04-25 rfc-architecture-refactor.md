# RFC: 当前架构重构方案

Status: Accepted

Owner: OpenCode

Last Updated: 2026-04-25

## 1. 目标

本次重构的核心目标有四个：

1. 将 agent 运行时从 `apps/server` 中抽离，形成可复用的 `packages/agent` 核心包。
2. 将 tool schema 和 tool 实现收拢到同一目录和同一文件，避免 schema/execute 分离。
3. 让 server 回归 host 层职责，只负责 HTTP、存储、事件、provider 适配和 runtime 装配。
4. 清理历史残留目录和命名噪音，统一服务目录的命名风格。

---

## 2. 最终分层

当前项目采用四层结构：

### 2.1 `packages/agent`: 纯 engine 层

`packages/agent` 只保留真正的 agent 运行时核心：

- checkpoint 读写与 continuation metadata
- model request 构造与 input 规范化
- run loop
- lifecycle 控制流
- session processor
- tool 执行分发
- tool schema + execute 实现

这个包不再承担以下职责：

- HTTP 错误映射
- session 级并发锁
- route 层 facade
- OpenAI client 实例化
- repository / service 装配

这意味着 `packages/agent` 现在是一个可注入的 engine 包，而不是 server app 的内部目录镜像。

### 2.2 `apps/server/services/ai`: provider adapter 层

`services/ai` 负责 OpenAI client 和模型配置，并通过 `response-stream.ts` 将 server 环境下的 OpenAI client 适配到 `packages/agent` 所需的 `streamModelResponse` 接口。

这层只负责 provider 接入，不负责 session 业务。

### 2.3 `apps/server/services/session`: session 业务层

`services/session` 负责：

- session 状态读写
- message 持久化
- event 发布
- approval 决策恢复
- session 级互斥运行

这层不再直接包含 agent runtime 实现，而是消费 `wiring/agent.ts` 中装配好的 `Lifecycle`。

### 2.4 `apps/server/wiring`: 应用装配层

`wiring/agent.ts` 是 server 的 composition root。它负责：

- 将 repository / service 依赖注入 `SessionProcessor`
- 组装 `RunLoop`
- 组装 `Lifecycle`

这层的存在是当前架构的刻意设计。引入可注入的 `packages/agent` 之后，server 必须有一个明确的 runtime 装配点。

---

## 3. 当前调用链

### 3.1 用户消息提交

当前提交链路为：

```text
Route
  -> SessionPromptService.prompt()
  -> SessionRunner.ensureRunning()
  -> Lifecycle.startPromptRun()
  -> RunLoop.run()
  -> SessionProcessor.processTurn()
```

### 3.2 approval 恢复

当前 approval 恢复链路为：

```text
Route
  -> SessionPromptService.resolveApproval()
  -> SessionRunner.ensureRunning()
  -> Lifecycle.resumeApprovalRun()
  -> SessionProcessor.executeApprovedToolCall()
  -> RunLoop.run()
```

### 3.3 SSE 推送

当前 SSE 相关链路为：

```text
SessionEventService.append()
  -> StreamHub.publish()

Route /stream
  -> StreamHub.subscribe()
  -> lib/sse.ts 写出 SSE envelope
```

---

## 4. `packages/agent` 的职责边界

`packages/agent/src/` 当前保留的文件如下：

```text
packages/agent/src/
├── checkpoint.ts
├── index.ts
├── lifecycle.ts
├── model-client.ts
├── prompt.ts
├── run-loop.ts
├── session-processor.ts
├── tool-executor.ts
└── tools/
    ├── diff.ts
    ├── guards.ts
    ├── index.ts
    ├── read-file.ts
    ├── run-command.ts
    └── write-file.ts
```

### 4.1 保留在 package 内的内容

- `checkpoint.ts`
  负责构造和解析 session checkpoint，以及读取 OpenAI continuation metadata。
- `model-client.ts`
  负责 Responses API request 构造、input 规范化、tool schema 转换。
- `prompt.ts`
  保留当前 system prompt 文本。它仍属于 engine 侧，因为模型请求构造依赖它。
- `run-loop.ts`
  负责控制迭代，直到 completed 或 paused_for_approval。
- `session-processor.ts`
  负责处理模型流、执行工具、落消息、生成 function call output。
- `lifecycle.ts`
  只做控制流编排，不直接承担 tool 执行细节。
- `tool-executor.ts`
  负责 tool 入参校验、执行前分流，以及 approval / auto execution 的统一入口。
- `tools/*`
  每个 tool 文件同时包含 schema 和 execute。

### 4.2 明确移回 server 的内容

以下内容不再属于 `packages/agent`：

- `AgentLoop`
- `SessionRunner`
- `ServiceError`
- runtime facade
- repository/service wiring

这些内容都属于 host 层，不属于 engine 层。

### 4.3 精简后的公开 API

`packages/agent/src/index.ts` 只导出 server 当前确实需要的核心接口：

- checkpoint helpers
- `Lifecycle`
- model request builder
- `SYSTEM_PROMPT`
- `RunLoop`
- `SessionProcessor`
- `readFileTool`

内部 helper、残留类型和 facade 已不再从包根暴露。

---

## 5. tool 组织方式

当前 tool 结构采用单文件闭包式组织：

- `read-file.ts`: schema + execute
- `write-file.ts`: schema + approval payload + execute
- `run-command.ts`: schema + execute

`tools/index.ts` 只做聚合：

- 聚合导出 `toolRegistry`
- 重新导出具体 tool

这样修改一个 tool 时，不需要再同步维护多个目录中的 schema 和 execute。

---

## 6. server 侧目录说明

### 6.1 `services/session`

当前 `services/session` 命名风格已经统一为目录内短名：

```text
apps/server/src/services/session/
├── event-service.ts
├── message-service.ts
├── prompt-service.ts
├── runner.ts
├── service.ts
└── stream-hub.ts
```

职责如下：

- `service.ts`
  session 聚合根读写、runtime state 更新、resume 信息读取。
- `message-service.ts`
  负责 session 下 message 的创建、列表和内容更新。
- `event-service.ts`
  负责 session event envelope 的持久化与发布。
- `prompt-service.ts`
  负责用户 prompt 提交与 approval 恢复的业务编排。
- `runner.ts`
  负责每个 session 的互斥运行。
- `stream-hub.ts`
  负责 session 级别的内存 pub/sub。

### 6.2 `services/workspace`

当前 `services/workspace` 也采用同样的目录内短名：

```text
apps/server/src/services/workspace/
└── service.ts
```

该 service 负责 workspace 创建、规范化路径、目录树读取等 host 侧能力。

### 6.3 `services/ai`

当前 `services/ai` 结构为：

```text
apps/server/src/services/ai/
├── index.ts
├── models.ts
├── provider.ts
└── response-stream.ts
```

职责如下：

- `provider.ts`
  OpenAI client 实例化
- `models.ts`
  模型和 store/stateless 配置读取
- `response-stream.ts`
  将 `packages/agent/model-client.ts` 的 request builder 适配到 server 的 OpenAI client

### 6.4 `wiring/agent.ts`

当前 server 新增：

```text
apps/server/src/wiring/
└── agent.ts
```

它的职责是：

- 构造 `SessionProcessorDeps`
- 构造 `SessionProcessor`
- 构造 `RunLoop`
- 构造 `Lifecycle`

这是本次重构里最重要的新增层之一。它让 engine 和 host 的依赖边界保持清晰。

---

## 7. 与最初目标结构的差异

当前实现和最初 RFC 草稿相比，有以下有意偏离：

### 7.1 不再保留 `AgentLoop`

原始草稿保留了：

```text
Route -> AgentLoop -> SessionPromptService
```

当前实现进一步简化为：

```text
Route -> SessionPromptService
```

这是刻意调整。`AgentLoop` 在当前项目里已经没有独立价值，只是一个薄薄的转发门面。

### 7.2 `runner` 不再属于 `packages/agent`

原始草稿将 `runner.ts` 算进 agent package。当前实现将其放回 server：

- session 级互斥运行是 host concern
- 它直接服务于 HTTP / approval 恢复 / detached run 场景
- 它不属于可复用 engine 核心

### 7.3 新增 `wiring/agent.ts`

原始草稿没有显式写出 composition root。当前实现将 runtime 装配明确落到 `wiring/agent.ts`。

这不是架构漂移，而是对“可注入核心包 + host app”结构的必要补充。

### 7.4 保留 `prompt.ts`

虽然包内做了整体瘦身，但 `prompt.ts` 仍然保留，因为当前 `SYSTEM_PROMPT` 仍然是 engine 层模型请求构造的一部分。

---

## 8. 已清理的历史残留

以下目录和文件已经从实现中移除：

- `packages/agent-core/`
- `apps/server/src/agent/`
- `apps/server/src/tools/`
- `apps/server/src/internal/`
- `apps/server/src/agent/runtime.ts`

这次重构后，server 不再携带旧 runtime 目录镜像，也不再保留 schema/execute 双轨结构。

---

## 9. 当前架构判断

当前架构的判断如下：

1. `packages/agent` 已经成为真正的 engine 包，而不是 server 目录的复制品。
2. tool schema 与 execute 已合并，职责边界清晰。
3. `Lifecycle` 与 `SessionProcessor` 的职责划分已经稳定。
4. server 已收口为 host 层：HTTP、事件、存储、provider adapter、runtime wiring。
5. 命名风格已经统一，目录层级比原始草稿更清楚。

因此，当前实现应视为对最初 RFC 的完成版和修正版，而不是对草稿目标结构的逐字实现。

---

## 10. 后续注意事项

当前仍有一个未收口但暂时不影响主线的问题：

- `/api/files/*` 路由仍然属于占位实现，它当前直接复用了 `@opencode/agent` 的 `readFileTool`。

这个问题不影响本次 agent/runtime 架构重构结论，但后续若继续推进 detail pane 文件预览，建议将其重构为 workspace 域的只读文件接口，而不是继续复用 agent tool。
