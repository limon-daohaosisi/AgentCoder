# Routes 层架构说明

这个目录是 HTTP/SSE transport 层。它负责把外部请求转换成 service 调用，并把 service 结果转换成 HTTP response。

## 职责边界

1. 负责注册 Hono routes、参数校验、JSON body 校验、HTTP status、SSE stream。
2. 调用 services 完成业务动作。
3. 捕获 `ServiceError` 并转换成 `{ error }` response。
4. 不直接访问 repositories，不直接跑 agent runtime。
5. 不承载复杂业务状态机。

## 文件组织

每个 route 子目录通常包含：

```text
xxx.route.ts    路由注册
xxx.handler.ts  handler 实现
xxx.schema.ts   请求参数/body/query schema
```

保持这个模式，避免把 schema、handler、service 混在一个大文件里。

## 依赖方向

正确方向：

```text
routes -> services
routes -> lib/validator
routes -> shared contracts/schemas
```

错误方向：

```text
routes -> repositories
routes -> db
routes -> packages/agent runtime internals
```

## 修改判断

1. 新增 API endpoint，先改 route/schema/handler，再调用 service。
2. 改请求参数校验，改 `*.schema.ts`，尽量复用 `packages/shared` 的 schema。
3. 改业务规则，不要写在 handler，放 service 或 agent core。
4. 改 SSE envelope 写法，可看 `lib/sse` 和 agent stream handler。
5. 改错误语义时，service 抛 `ServiceError`，handler 只负责转换。

## 实现规则

1. handler 保持薄：validate -> call service -> return JSON/SSE。
2. 不要在 handler 中组合多个 repository 来完成业务流程。
3. HTTP status 应表达 transport 结果，业务失败细节由 service error message 提供。
4. SSE handler 可以处理连接、重放、keepalive，但不要改变 agent 业务状态。
5. route schema 与 shared contract 不要长期漂移；公共输入优先放 shared。

## 常见错误

1. 在 handler 中直接调用 repository 创建 message/session。
2. 在 route 中写 approval resume 校验。
3. 在 route 中拼装复杂 view model 给前端。
4. 新增 body 类型但没有同步 shared contract 或前端 API client。
5. SSE 连接逻辑里夹带业务状态更新。

## 验证建议

改这个目录后优先运行：

```bash
pnpm --filter @opencode/server typecheck
pnpm --filter @opencode/server test
pnpm typecheck
```
