# Repositories 层架构说明

这个目录是数据库访问层。它负责 Drizzle/SQLite 查询、写入、row 到 DTO 的映射。这里不表达完整业务流程，只提供持久化能力。

## 职责边界

1. 负责读取和写入数据库表。
2. 负责把 ORM row 映射成 `@opencode/shared` 中的 DTO。
3. 可以使用 `@opencode/orm` schema、Drizzle query helper、server DB runtime。
4. 不应该调用 services、routes、wiring 或 agent runtime。
5. 不应该发送 session event；事件是否发送由 service/agent 流程决定。

## 依赖方向

正确方向：

```text
services -> repositories -> db/runtime -> db/client -> @opencode/orm
```

错误方向：

```text
repositories -> services
repositories -> routes
repositories -> packages/agent runtime
repositories -> web
```

## 修改判断

1. 新增一种数据库查询或更新，改 repository。
2. 新增表/字段，先走数据库 schema/migration/ORM 同步，再改 repository。
3. 跨多个表的业务事务或流程判断，默认放 service；只有 recovery 这类专用持久化模块可以在 repository 内显式承载事务性批量写入。
4. DTO 字段变化时，检查对应 row mapper。
5. JSON 字段读写时，统一使用已有 JSON helper，避免散落 `JSON.parse/stringify`。

## 实现规则

1. repository 方法名描述数据访问动作，例如 `getById`、`listBySession`、`updateRuntime`。
2. 返回 DTO 或 `null`，不要把 Drizzle row 泄漏到 service。
3. mapper 函数放在 repository 文件内，保持表结构细节局部化。
4. repository 默认通过 `Database.use((db) => ...)` 取当前 ambient transaction 或 root db，不再直接散落全局 `db` 调用。
5. 如果一个 repository 方法内部必须自己保证原子单元，例如 `sessionEventRepository.append()` 的 sequence 分配，使用 `Database.transaction(...)`，并确保在外层事务存在时自动复用 ambient transaction。
6. 更新方法只处理持久化，不负责发事件、跑 agent、返回 HTTP status。
7. 对 optional/null 字段保持一致映射，避免前端 contract 漂移。

## 常见错误

1. repository 里抛业务语义的 `ServiceError`。
2. repository 里调用 `sessionEventService.append`。
3. repository 里根据 session 状态决定是否允许某个业务动作。
4. 直接返回数据库 row，导致 service/web 依赖 DB 字段名。
5. 在可复用的普通 repository 中直接 `import { db } from '../db/client.js'`，绕过 ambient transaction。
6. 新增字段后只改 ORM，不改 mapper 或测试。

## 验证建议

改这个目录后优先运行：

```bash
pnpm --filter @opencode/server typecheck
pnpm --filter @opencode/server test
pnpm typecheck
```
