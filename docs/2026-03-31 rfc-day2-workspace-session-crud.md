# RFC: Day 2 Workspace + Session CRUD 落地方案

Status: Draft

Owner: Codex

Last Updated: 2026-03-31

## 1. 背景

根据 [docs/opencode-web-lite-mvp.md](./opencode-web-lite-mvp.md) 的两周排期，Day 2 的目标是：

1. 落 SQLite schema。
2. 跑通 workspace + session CRUD。

第 1 部分已经完成，当前仓库已经具备：

- `packages/db`
  Atlas HCL 和 migration，作为数据库 schema source of truth。
- `packages/orm`
  基于 SQLite introspection 生成的 Drizzle schema。
- `apps/server/src/db/client.ts`
  SQLite 连接和 PRAGMA 初始化。

但 Day 2 仍未完成，因为服务端仍然停留在内存 stub 阶段：

- [`apps/server/src/services/workspace-service.ts`](../apps/server/src/services/workspace-service.ts)
- [`apps/server/src/services/session-service.ts`](../apps/server/src/services/session-service.ts)

这两个 service 仍然使用 `Map` 存假数据，导致：

1. API 行为没有以数据库 schema 为准。
2. 重启服务后数据不会保留。
3. route contract 和 schema 已经开始漂移。

当前最明显的漂移是：

- `sessions.goal_text` 在 schema 中是 `NOT NULL`
- 但现有 `POST /api/sessions` 语义只要求 `workspaceId + title`
- `packages/shared/src/dto.ts` 中的 `SessionStatus` 仍然是老的 `active` 模型，而 schema 已经升级为 `planning / executing / waiting_approval / blocked / failed / completed / archived`

因此，Day 2 的核心工作不是“再加几条路由”，而是把 contract、repository、service 和 route 全部切换到 schema-first。

## 2. 结论

本 RFC 的结论只有一条：

`packages/db` 中定义的 SQLite schema 是唯一真相。

实现上采用以下策略：

1. 先统一 contract，让 shared DTO 与 schema 保持一致。
2. 在 `apps/server/src/repositories` 建一层最薄的 DB repository。
3. 用 repository 替换现有 workspace / session service 的内存实现。
4. 补齐 Day 2 最小路由面。
5. 以一条最小 smoke path 作为完成标准，而不是提前进入 agent loop、plan/task、SSE 的后续范围。

## 3. 非目标

Day 2 不做以下内容：

1. `plan` / `task` / `approval` / `artifact` repository。
2. 真正的 resume execution。
3. 前端接通这些 CRUD。
4. 真实 SSE 恢复链路。
5. 完整校验层、鉴权层、错误码体系重构。

这些能力都依赖 workspace + session 基础 CRUD 先稳定。

## 4. 设计原则

### 4.1 Schema-first

所有后端 contract、DTO、service 和 repository 行为都必须以 `packages/db` 定义的 schema 为准，而不是以现有 stub、mock data 或旧类型为准。

具体含义：

1. schema 里存在的字段，DTO 不能少。
2. schema 里已经收紧的状态枚举，DTO 和 service 不能继续保留旧值。
3. schema 里是必填字段，API contract 也必须体现必填。
4. route 返回的对象语义要能稳定映射回数据库行。

### 4.2 薄 repository，薄 route，service 负责业务编排

Day 2 不引入复杂架构，但也不把 SQL 直接散落到 route handler。

推荐职责：

1. repository
   只做数据库读写、排序、where 条件、行到领域对象映射。
2. service
   负责路径规范化、去重、默认值、resume 响应拼装等业务编排。
3. route
   负责 HTTP 入参读取、调用 service、返回 JSON。

### 4.3 Workspace 状态与 Session 执行态分离

`workspace` 和 `session` 不是同一层对象，不能混着建模。

约束如下：

1. `workspaces` 只承载 workspace 自身身份、路径和最近访问时间。
2. `sessions` 只承载单次 goal 执行的当前态。
3. trust、workspace 设置、onboarding、IDE 绑定这类 project-scoped 状态不进入 `sessions`。
4. 如果后续需要持久化 workspace 长期配置，应单独新增 `workspace_settings` 或独立表，而不是挤进 `sessions`。

### 4.4 当前态与执行日志双轨

本项目后续一定会同时存在：

1. current-state 表
2. append-only replay log

Day 2 先明确语义，不提前实现全部链路：

1. `sessions` 是 current-state 表。
2. `session_events` 是 append-only replay log。
3. session 列表和 session header 一律以 `sessions` 为准。
4. 不能通过扫描 `session_events` 回放来推导 session 当前态。

### 4.5 只做最小闭环，不提前扩 Day 3+

Day 2 的目标是让 workspace 和 session 成为真实可持久化的顶层对象。

因此：

- `POST /api/sessions` 只负责建立 session
- 不在这个阶段自动生成 plan
- `resume` 只返回可恢复状态，不触发 agent 执行

## 5. 参考 `mono-demo-273` 后的适配结论

本项目可以参考 `../mono-demo-273` 的分层思想，但不能照抄其 PostgreSQL/Neon 细节。

本次主要参考的不是具体 SQL，而是以下组织方式：

1. `db client` 独立于业务层。
   参考：`../mono-demo-273/apps/server/src/db/client.ts`
2. 复杂查询封装在 service / query helper 中，而不是直接塞进 route。
   参考：`../mono-demo-273/apps/server/src/services/credits/credits.queries.ts`
3. handler 本身保持薄，只负责读参数和返回结果。
   参考：`../mono-demo-273/apps/server/src/data/resources/drafts/drafts.handler.ts`

本项目的适配方式：

1. 保留现有 `apps/server/src/db/client.ts` 作为 SQLite 运行时入口。
2. 新增 repository 层承接最基础 CRUD。
3. 现有 `workspace-service` / `session-service` 继续保留为业务服务层，但底层改走 repository。
4. route 不直接操作 Drizzle。

原因很简单：

- 这个项目的 CRUD 规模比 `mono-demo-273` 小很多，不需要完整复制它的模块体系。
- 但如果没有 repository 分层，后面接 plan/task/tool_call 时会很快把 route 写乱。

## 6. Day 2 范围内的 contract 统一

### 6.1 `SessionStatus` 以 schema 为准

[`packages/shared/src/dto.ts`](../packages/shared/src/dto.ts) 中的 `SessionStatus` 必须改为：

```ts
export type SessionStatus =
  | 'planning'
  | 'executing'
  | 'waiting_approval'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'archived';
```

不能再保留 `active`，因为数据库不会产生这个状态。

### 6.2 `SessionDto` 对齐 schema

`sessions` 表当前字段如下：

- `id`
- `workspace_id`
- `title`
- `goal_text`
- `status`
- `current_plan_id`
- `current_task_id`
- `last_error_text`
- `last_checkpoint_json`
- `created_at`
- `updated_at`
- `archived_at`

因此 `SessionDto` 至少应补齐：

```ts
export type SessionDto = {
  id: string;
  workspaceId: string;
  title: string;
  goalText: string;
  status: SessionStatus;
  currentPlanId?: string;
  currentTaskId?: string;
  lastErrorText?: string;
  lastCheckpointJson?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};
```

说明：

1. DTO 层保持 camelCase。
2. schema / ORM 保持 snake_case 到 camelCase 的 Drizzle 字段映射。
3. `lastCheckpointJson` 在 DTO 层先保留字符串存储形式，但它的业务语义必须是 resume 锚点，而不是随意备注字段。

### 6.3 `WorkspaceDto` 与 schema 保持一致

当前 `WorkspaceDto` 基本已经覆盖核心字段，但建议显式补齐 `createdAt`，与 `workspaces` 表完全对齐：

```ts
export type WorkspaceDto = {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
};
```

如果 DTO 不补 `createdAt`，后面列表和详情对象会持续出现“数据库有、接口不暴露”的不一致。

### 6.4 `create session` 请求语义改成 schema-first

现有语义隐含问题：

1. `sessions.goal_text` 是必填，但请求没有它。
2. `title` 其实只是展示字段，不应该成为创建 session 的主语义。

建议将 `POST /api/sessions` 请求体定义为：

```ts
export type CreateSessionInput = {
  workspaceId: string;
  goalText: string;
  title?: string;
};
```

创建规则：

1. `workspaceId` 必填。
2. `goalText` 必填。
3. `title` 可选。
4. 未传 `title` 时，由 service 基于 `goalText` 自动生成短标题。

建议的自动标题策略：

1. `trim()` 后取第一行。
2. 去掉连续空白。
3. 截断到 60 个字符。
4. 为空时回退为 `New session`。

这样可以保证：

- 用户真正创建的是一条 goal-driven session。
- UI 仍然可以拿到稳定标题。

### 6.5 补齐 Day 2 需要的返回类型

建议在 `packages/shared/src/dto.ts` 中新增或显式定义以下类型：

```ts
export type ResumeSessionDto = {
  canResume: boolean;
  session?: SessionDto;
  checkpoint?: string;
};
```

`checkpoint` 在 Day 2 可直接等于 `lastCheckpointJson`，后续再升级为结构化对象。

同时需要补充一个最小语义约束：

- `lastCheckpointJson` 在存储层虽然还是 JSON 字符串，但内容必须表示“最近一次可恢复位置”
- 后续 plan/task 接入后，每次关键状态流转都应同步刷新它

推荐的最小 checkpoint 结构如下：

```ts
export type SessionCheckpoint = {
  kind:
    | 'session_created'
    | 'planning'
    | 'waiting_plan_confirmation'
    | 'executing_task'
    | 'waiting_approval'
    | 'failed'
    | 'completed';
  updatedAt: string;
  planId?: string;
  taskId?: string;
  approvalId?: string;
  note?: string;
};
```

Day 2 不要求完整消费这个结构，但 RFC 必须先把字段语义钉住。

## 7. Repository 设计

### 7.1 目录结构

建议新增：

```text
apps/server/src/repositories/
├── workspace-repository.ts
└── session-repository.ts
```

这层只依赖：

- `apps/server/src/db/client.ts`
- `@opencode/orm`
- `drizzle-orm`

### 7.2 `workspace-repository` 负责内容

职责限定为：

1. `create`
2. `list`
3. `getById`
4. `getByRootPath`
5. `touchLastOpenedAt`

建议接口：

```ts
export type WorkspaceRecord = WorkspaceDto;

export interface WorkspaceRepository {
  create(input: {
    id: string;
    name: string;
    rootPath: string;
    createdAt: string;
    updatedAt: string;
    lastOpenedAt: string;
  }): WorkspaceRecord;
  list(): WorkspaceRecord[];
  getById(id: string): WorkspaceRecord | null;
  getByRootPath(rootPath: string): WorkspaceRecord | null;
  touchLastOpenedAt(id: string, now: string): WorkspaceRecord | null;
}
```

查询规则：

1. `list()` 按 `lastOpenedAt DESC`。
2. `getByRootPath(rootPath)` 用于路径去重。
3. `touchLastOpenedAt(id, now)` 同时更新 `lastOpenedAt` 和 `updatedAt`。

### 7.3 `session-repository` 负责内容

职责限定为：

1. `create`
2. `listByWorkspace`
3. `getById`
4. `updateResumeState`

建议接口：

```ts
export type SessionRecord = SessionDto;

export interface SessionRepository {
  create(input: {
    id: string;
    workspaceId: string;
    title: string;
    goalText: string;
    status: SessionStatus;
    createdAt: string;
    updatedAt: string;
    currentPlanId?: string;
    currentTaskId?: string;
    lastErrorText?: string;
    lastCheckpointJson?: string;
    archivedAt?: string;
  }): SessionRecord;
  listByWorkspace(workspaceId: string): SessionRecord[];
  getById(id: string): SessionRecord | null;
  updateResumeState(input: {
    id: string;
    updatedAt: string;
    status?: SessionStatus;
    currentTaskId?: string | null;
    lastCheckpointJson?: string | null;
    lastErrorText?: string | null;
  }): SessionRecord | null;
}
```

查询规则：

1. `listByWorkspace(workspaceId)` 按 `updatedAt DESC`。
2. `getById(id)` 返回单条 session。
3. `updateResumeState` 是 Day 2 为 `resume` 预留的最小更新能力。
4. `listByWorkspace(workspaceId)` 只查询 `sessions` 表，不 join `messages`、`session_events`、`artifacts` 等重对象。

### 7.4 Repository 实现要求

这层需要认真构建，不能退化成“service 里的 SQL 搬家”。

最低要求：

1. 每个 repository 都有明确的 row-to-dto mapper。
2. route 不直接 import `db`。
3. service 不手写字段映射。
4. 所有排序、where 条件都固化在 repository 内。

建议实现形式：

```ts
function mapWorkspaceRow(
  row: typeof schema.workspaces.$inferSelect
): WorkspaceDto;
function mapSessionRow(row: typeof schema.sessions.$inferSelect): SessionDto;
```

理由：

1. DTO 必须对齐 schema，但 HTTP 响应不应直接暴露 ORM 行对象。
2. 后面 schema 继续演进时，只需集中修改 mapper。
3. 可以避免 route/service 不同位置各自拼字段，逐步漂移。

## 8. Service 替换方案

### 8.1 `workspace-service` 替换目标

[`apps/server/src/services/workspace-service.ts`](../apps/server/src/services/workspace-service.ts) 当前是内存 `Map` 和 `sampleTree`。

替换后的职责应为：

1. `createWorkspace(rootPath)`
2. `listWorkspaces()`
3. `getWorkspace(workspaceId)`
4. `getTree(workspaceId)`

### 8.2 `createWorkspace(rootPath)` 行为

执行顺序：

1. 先将输入路径转成 absolute path。
2. 若路径存在，继续取 `realpath`，得到 canonical path。
3. 校验 canonical path 指向目录，而不是普通文件。
4. 用 canonical path 生成稳定 `name`。
5. 先调用 `workspaceRepository.getByRootPath(canonicalPath)` 查重。
6. 已存在时：
   - 调用 `touchLastOpenedAt`
   - 返回现有 workspace
7. 不存在时：
   - 生成 `id`
   - 写入数据库
   - 返回新 workspace

说明：

1. 去重标准必须是 canonical path，而不只是 `resolve()` 后的字符串。
2. `POST /api/workspaces` 不应为同一路径创建多条记录。
3. `workspaces.root_path UNIQUE` 的业务语义应理解为“唯一 canonical root path”。
4. 如果路径不存在或不是目录，Day 2 直接返回 400。

### 8.3 `listWorkspaces()` 行为

直接调用 repository。

排序规则固定：

- `lastOpenedAt DESC`

### 8.4 `getTree(workspaceId)` 行为

Day 2 继续沿用文件系统扫描思路，但数据源必须改为数据库：

1. 先通过 `workspaceRepository.getById(workspaceId)` 取出 workspace。
2. 拿到 `rootPath` 后再读文件系统。
3. 若 workspace 不存在，返回明确错误。

注意：

- Day 2 这里不需要做完整路径守卫增强。
- 但不能继续使用 `sampleTree` 假数据。

## 9. Session Service 替换方案

### 9.1 `session-service` 替换目标

[`apps/server/src/services/session-service.ts`](../apps/server/src/services/session-service.ts) 当前使用内存 `Map` 持有 session 和 message。

Day 2 只替换 session 相关职责，不扩到 message 写入。

替换后的核心职责：

1. `createSession(workspaceId, goalText, title?)`
2. `listSessions(workspaceId)`
3. `getSession(sessionId)`
4. `resumeSession(sessionId)`

### 9.2 `createSession` 行为

执行顺序：

1. 先校验 workspace 是否存在。
2. 基于 `goalText` 和可选 `title` 生成最终标题。
3. 创建 session，默认：
   - `status = 'planning'`
   - `currentPlanId = null`
   - `currentTaskId = null`
   - `lastErrorText = null`
   - `lastCheckpointJson = null`
   - `archivedAt = null`
4. 写入数据库。
5. 返回创建后的 `SessionDto`。

注意：

- Day 2 不自动创建 `messages`。
- Day 2 不自动触发 planner。

### 9.3 `listSessions(workspaceId)` 行为

执行顺序：

1. 若未传 `workspaceId`，直接返回空数组或 route 层拦截为 400。
2. 查询该 workspace 下全部 session。
3. 按 `updatedAt DESC` 返回。

建议采用严格模式：

- 缺少 `workspaceId` 时返回 400。

原因：

- 文档中的 `GET /api/sessions?workspaceId=...` 已经明确该接口是 workspace-scoped。
- Day 2 不需要提供全局 session 列表。
- 列表所需的 `title / goalText / status / updatedAt` 都必须由 `sessions` 直接提供。
- 不允许通过 join `messages`、`session_events`、`artifacts` 来拼列表摘要。

### 9.4 `getSession(sessionId)` 行为

直接通过 repository 按 ID 查询。

若不存在：

- 返回 `null` 给 route，由 route 转 404。

### 9.5 `resumeSession(sessionId)` 的最小版定义

Day 2 的 `resume` 只解决“读取当前可恢复状态”，不解决“真正恢复执行”。

建议返回：

```ts
{
  canResume: boolean;
  session?: SessionDto;
  checkpoint?: string;
}
```

行为：

1. session 不存在，返回 `canResume: false`
2. session 存在，返回：
   - `canResume: true`
   - `session`
   - `checkpoint = session.lastCheckpointJson`

补充约束：

1. `checkpoint` 不是任意备注，而是恢复入口锚点。
2. Day 2 即使只读不写，也要把 `lastCheckpointJson` 当成正式 contract。
3. 后续一旦接入 plan/task/approval，关键状态切换必须同步更新 `sessions.last_checkpoint_json`。

可选增强：

- 如果 `session.status === 'archived'`，可返回 `canResume: false`

但 Day 2 可以先不加额外状态门槛。

## 10. Route 面设计

### 10.1 Day 2 必保路由

必须跑通：

1. `POST /api/workspaces`
2. `GET /api/workspaces`
3. `GET /api/workspaces/:workspaceId/tree`
4. `POST /api/sessions`
5. `GET /api/sessions?workspaceId=...`
6. `GET /api/sessions/:sessionId`
7. `POST /api/sessions/:sessionId/resume`

### 10.2 `POST /api/workspaces`

请求体：

```json
{
  "rootPath": "/absolute/path/to/project"
}
```

响应：

```json
{
  "data": {
    "id": "workspace-xxx",
    "name": "project",
    "rootPath": "/absolute/path/to/project",
    "createdAt": "2026-03-31T00:00:00.000Z",
    "updatedAt": "2026-03-31T00:00:00.000Z",
    "lastOpenedAt": "2026-03-31T00:00:00.000Z"
  }
}
```

语义：

1. 同一路径重复创建，不新增记录。
2. 只更新时间并返回已有记录。

### 10.3 `POST /api/sessions`

请求体：

```json
{
  "workspaceId": "workspace-xxx",
  "goalText": "Review the auth flow and patch redirect handling",
  "title": "Refine auth redirect behavior"
}
```

`title` 可省略。

响应返回 `SessionDto`。

### 10.4 `GET /api/sessions/:sessionId`

现有路由缺失，Day 2 必须补上。

用途：

1. 刷新后恢复当前 session header。
2. 后续页面首次进入时加载 session 元信息。

### 10.5 错误处理的最小约定

Day 2 不要求建立完整错误模型，但建议最少做到：

1. 资源不存在返回 404。
2. 缺少必填参数返回 400。
3. 数据库异常返回 500。

如果暂时没有统一错误 helper，也要保证 route 层不要静默返回 `undefined`。

## 11. 文件级改动计划

### 11.1 `packages/shared`

需要修改：

- [`packages/shared/src/dto.ts`](../packages/shared/src/dto.ts)

建议内容：

1. 更新 `SessionStatus`
2. 更新 `WorkspaceDto`
3. 更新 `SessionDto`
4. 新增 `CreateSessionInput`
5. 新增 `ResumeSessionDto`

### 11.2 `apps/server/src/repositories`

需要新增：

- `workspace-repository.ts`
- `session-repository.ts`

建议每个文件内容包含：

1. schema import
2. mapper
3. repository object
4. 最小 CRUD 方法

### 11.3 `apps/server/src/services`

需要修改：

- [`apps/server/src/services/workspace-service.ts`](../apps/server/src/services/workspace-service.ts)
- [`apps/server/src/services/session-service.ts`](../apps/server/src/services/session-service.ts)

改造方式：

1. 保留 service 文件名，降低改动面。
2. 内部实现改为调用 repository。
3. 移除内存 `Map` 假数据。

### 11.4 `apps/server/src/routes`

需要修改：

- [`apps/server/src/routes/workspaces.ts`](../apps/server/src/routes/workspaces.ts)
- [`apps/server/src/routes/sessions.ts`](../apps/server/src/routes/sessions.ts)

改动重点：

1. `POST /api/sessions` 改成读 `goalText`
2. 补 `GET /api/sessions/:sessionId`
3. 对缺少参数的情况做最小返回约束

## 12. Smoke Path 与完成标准

Day 2 的完成标准不是“agent 已能执行任务”，而是以下链路跑通：

1. `POST /api/workspaces`
2. `GET /api/workspaces`
3. `POST /api/sessions`
4. `GET /api/sessions?workspaceId=...`
5. `GET /api/sessions/:sessionId`
6. `POST /api/sessions/:sessionId/resume`

具体验收标准：

1. workspace 和 session 数据真实落 SQLite。
2. 重启 server 后再次查询仍能读到数据。
3. 相同 `rootPath` 不会创建重复 workspace。
4. session 创建时未传 `title` 也能成功。
5. session 默认状态为 `planning`。
6. session 列表按 `updatedAt DESC` 返回。
7. workspace 列表按 `lastOpenedAt DESC` 返回。
8. `GET /api/workspaces/:workspaceId/tree` 不再返回硬编码树。
9. `pnpm --filter @opencode/server typecheck` 通过。
10. `pnpm --filter @opencode/shared typecheck` 通过。

## 13. 风险与控制

### 13.1 DTO 与 schema 再次漂移

风险：

- 改 service 和 route 时只修一半，shared 类型仍保留旧字段。

控制：

1. 先改 `packages/shared/src/dto.ts`
2. 再改 repository / service / route
3. 任何 route 返回对象都通过 mapper 产出

### 13.2 把 Day 3 的 plan/task 范围提前引入

风险：

- 为了“顺手一次做完”，把 `plans` / `tasks` 也接进来，导致 Day 2 交付延期。

控制：

1. repository 只建 `workspace` 和 `session`
2. `resume` 只返回当前状态，不做真正恢复执行

### 13.3 文件树逻辑继续依赖假数据

风险：

- workspace CRUD 虽然落库了，但 `tree` 仍然返回 `sampleTree`

控制：

1. `getTree(workspaceId)` 必须先查 DB
2. 文件树内容必须来自真实 `rootPath`

## 14. 实施顺序

推荐按以下顺序提交：

1. 改 shared DTO 和输入输出 contract。
2. 新建 `workspace-repository` / `session-repository`。
3. 替换 `workspace-service`。
4. 替换 `session-service`。
5. 补路由和最小错误处理。
6. 手动跑 smoke path。
7. 跑 typecheck。

这个顺序的原因是：

1. contract 先收口，避免后续来回返工。
2. repository 先落好，service 改造会很直接。
3. `workspace` 先稳定后，`session` 才能可靠引用 `workspaceId`。

## 15. 后续衔接

Day 2 完成后，Day 3 才适合继续推进：

1. `goal` 输入接 `POST /api/sessions`
2. session 创建成功后进入 planning 状态
3. 开始补 `plan draft` 和 `task list` 骨架

那时新增的 `plans` / `tasks` 能自然挂在已经稳定的 `session` 顶层对象之下，不需要再回头重做 workspace/session 基础层。
