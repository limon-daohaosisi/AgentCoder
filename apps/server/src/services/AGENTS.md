# Services 层架构说明

这个目录是 server 的应用服务层。它负责把一个用户动作编排成完整业务流程，例如创建 session、提交消息、处理 approval、更新 runtime state、追加 session event。

## 职责边界

1. 负责业务用例编排，不直接关心 HTTP response 格式。
2. 可以调用 repositories、wiring 暴露的运行时、其他 service、shared/agent 的纯类型或校验函数。
3. 可以抛出 `ServiceError` 表达业务错误，由 routes 转成 HTTP response。
4. 应该维护业务一致性，例如 session 状态、message/tool/approval/event 的组合更新。
5. 不应该直接承担 DB row 映射；row 到 DTO 的映射放 repositories。

## 子目录语义

1. `agent/`：用户与 agent runtime 的交互编排，例如 prompt、approval resolve、run 防并发。
2. `session/`：session 生命周期、message、message part、resume 等 session 领域能力。
3. `session-events/`：session event 的追加、查询、广播入口。
4. `ai/`：模型 provider、response stream 等 AI SDK 适配。
5. `workspace/`：workspace 创建、查询、文件树等 workspace 用例。

## 依赖方向

正确方向：

```text
routes -> services -> repositories
services -> wiring/packages/agent when running agent workflows
services -> session-events when publishing domain events
```

关键实现约定：

```text
services -> Database.transaction(...) -> repositories/session-events
services -> Database.effect(...) for after-commit side effects
```

错误方向：

```text
services -> routes
services -> React/web
repositories -> services
```

## 修改判断

1. 一个接口需要跨多个 repository 更新，通常改 service。
2. 需要检查 session 状态、approval 状态、checkpoint 是否可恢复，通常改 service 或 `packages/agent` 的校验函数。
3. 只是新增 HTTP path，不要把逻辑写在 route，route 调 service。
4. 只是新增 DB 查询，不要把查询散在 service，先给 repository 增加方法。
5. 只是 UI 展示转换，不要放 service，优先放 web 的 view model 或 API 返回 contract。

## 实现规则

1. service 方法名表达业务动作，例如 `createSession`、`resumeSession`、`resolveApproval`。
2. service 可以组合多个 repository，但要保持流程清晰，不要变成巨大工具箱。
3. 涉及多个 durable write 的业务动作，默认由 service 作为事务边界，使用 `Database.transaction(...)` 把 projection 更新和 `sessionEventService.append(...)` 包进同一个短事务。
4. 长任务执行必须经过 `SessionRunner` 或等价机制，避免同一 session 并发运行。
5. 不要在 service 里返回 DB row；返回 DTO 或明确的 response model。
6. `sessionEventService.append(...)` 现在只负责“durable append + 注册 after-commit publish”。service 不应在事务内直接触发 `sessionStreamHub.publish(...)`。
7. `agent/` 中的 run 边界以 `AgentRunService` 为准：prompt/resume 只启动或恢复 run；run terminalize、approval pause、cancel cleanup 等原子持久化动作优先沉到 `AgentRunService` 这类高层动作中统一处理。
8. server 启动恢复历史 `running`/`waiting_approval` run 时，应实现为 service 层的启动恢复用例并调用 repositories/session-events；不要放在 routes 或 `packages/agent`。

## 常见错误

1. route handler 里写了本该属于 service 的流程。
2. service 直接拼接 SQL 或处理 Drizzle row 细节。
3. 更新 session/message/tool 状态但忘记写 session event。
4. 新增 agent 流程时绕过 `SessionRunner`，导致并发 run。
5. 把应该在同一个事务里的 projection 更新拆成多次独立提交。
6. 把前端展示字段硬编码进服务层，污染业务用例。

## 验证建议

改这个目录后优先运行：

```bash
pnpm --filter @opencode/server typecheck
pnpm --filter @opencode/server test
pnpm typecheck
```
