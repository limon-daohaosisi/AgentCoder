# Wiring 层架构说明

这个目录是 server 的依赖装配层。它把 `packages/agent` 需要的抽象 deps 接到 server 的真实实现上，例如 services、repositories、AI provider、event service。

## 职责边界

1. 负责创建和连接运行时对象，例如 `Lifecycle`、`RunLoop`、`SessionProcessor`、`ToolExecutor`。
2. 负责把 agent core 的 port 接到 server service/repository 实现。
3. 可以 import `packages/agent`、server services、server repositories、AI provider。
4. 不应该承载业务流程本身；业务编排放 `apps/server/src/services`。
5. 不应该处理 HTTP request/response；HTTP 逻辑放 `apps/server/src/routes`。

## 依赖方向

正确方向：

```text
routes/services -> wiring -> packages/agent
wiring -> services/repositories/provider
```

注意：`wiring` 是装配点，可以接触多个层，但不要把它变成业务层。

## 修改判断

1. agent 新增 deps 时，通常需要在这里补接线。
2. 替换模型提供方、stream adapter、tool executor 实例，通常改这里或 `services/ai`。
3. 改 session prompt/approval 的业务流程，不要放这里，去 `services/agent/interaction-service.ts`。
4. 改数据库查询，不要放这里，去 `repositories`。
5. 改 HTTP 参数校验，不要放这里，去 `routes`。

## 实现规则

1. 这个目录的代码应该薄，主要是 `buildXxxDeps` 和实例化。
2. 不要在 deps 回调里写复杂业务逻辑；超过几行的逻辑应下沉到 service。
3. 保持 agent core 与 server 的隔离，不要反向让 `packages/agent` import server。
4. 事务能力仍只存在于 server。若 agent core 需要把多次持久化收口到一个短事务，应在 wiring 中注入高层动作，例如 `persist(...)`、`finalizeRunState(...)`、`pauseForApproval(...)`，而不是把 DB/tx 直接暴露给 `packages/agent`。
5. 增加新的 deps 时，优先使用小接口，不要把整个 service 对象无脑传入。
6. 测试需要替换 deps 时，应通过 builder 的 `overrides` 完成。

## 常见错误

1. 把 prompt/approval/cancel 的完整流程写在 wiring。
2. 在 wiring 中直接拼 HTTP response。
3. 在 wiring 中直接写复杂 SQL 或 repository 映射。
4. 把 server DB client 或 transaction object 直接传进 `packages/agent`。
5. 把一个庞大的 service 传给 agent core，导致 core 隐式依赖 server。
6. 新增 agent deps 后忘记更新 server tests 的 mock/override。

## 验证建议

改这个目录后优先运行：

```bash
pnpm --filter @opencode/server typecheck
pnpm --filter @opencode/server test
pnpm typecheck
```
