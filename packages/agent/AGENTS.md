# Agent 包架构说明

这个包是 AI agent 的执行内核。它负责模型上下文、运行循环、流式响应处理、工具策略、审批暂停和恢复。这里不是 server，也不是数据库访问层。

## 职责边界

1. 负责 agent 行为本身：context 构建、tool registry、run loop、session processor、tool executor、checkpoint/resume 规则。
2. 可以依赖 `@opencode/shared` 的 DTO、事件和 contract 类型。
3. 不允许依赖 `apps/server`、Hono、SQLite、Drizzle repository、React 或浏览器 API。
4. 所有外部副作用都应该通过 deps/port 注入，例如 `createMessage`、`appendSessionEvent`、`updateSessionRuntimeState`、`modelFactory`。
5. 这里定义的是“agent 应该怎么运行”，不是“server 如何接收 HTTP 请求”。

## 依赖方向

正确方向：

```text
apps/server/src/wiring -> packages/agent -> packages/shared
```

错误方向：

```text
packages/agent -> apps/server
packages/agent -> apps/server/src/repositories
packages/agent -> apps/server/src/db
```

## 修改判断

1. 改模型上下文、工具暴露、最大步数、流式处理、审批暂停/恢复逻辑，通常改这里。
2. 改 HTTP 接口、请求参数、状态码，不要改这里，去 `apps/server/src/routes`。
3. 改数据库读写，不要改这里，去 `apps/server/src/repositories` 或 `apps/server/src/services`。
4. 改 server 如何把 repository/service 注入 agent，不要改这里，去 `apps/server/src/wiring`。
5. 改前后端共享 DTO 或事件类型，去 `packages/shared`。

## 实现规则

1. 保持类和函数尽量纯粹，通过构造参数或 deps 对象接收副作用能力。
2. 不要在这里直接读取环境变量；模型提供方和配置应由 server wiring 注入。
3. 不要直接写入数据库；需要持久化时新增或扩展 deps。
4. 如果一个 agent 内部动作需要“多次持久化 + append event”保持原子性，优先要求 server 注入高层原子动作，例如 `persist(...)`、`pauseForApproval(...)`、`finalizeRunState(...)`，而不是让 agent core 感知 tx/db 细节。
5. approval pause 这类跨执行阶段动作，应返回结构化意图给 server，由 server 统一持久化成 durable truth。
6. 不要为了某个 UI 展示细节污染核心类型；展示转换应放在 web 或 server adapter。
7. 修改 tool 行为时，同时检查 tool input schema、tool policy、approval/resume、相关测试。

## 常见错误

1. 在 `packages/agent` 中 import server service 或 repository。
2. 把 HTTP 错误码、Hono response 写进 run loop。
3. 绕过 `SessionProcessorDeps` 直接持久化 message/tool call。
4. 在 agent core 里假定 live publish 可以替代 durable write。
5. 修改 approval 行为但忘记同步 checkpoint/resume 校验。
6. 把一次具体产品页面需求硬编码进 agent core。

## 验证建议

改这个包后优先运行：

```bash
pnpm --filter @opencode/agent typecheck
pnpm --filter @opencode/server test
pnpm typecheck
```
