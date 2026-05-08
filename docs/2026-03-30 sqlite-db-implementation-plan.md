# SQLite 数据库实施方案

Status: Draft

Owner: Codex

Last Updated: 2026-03-30

## 1. 目标

这份文档回答三个问题：

1. 这个项目要不要参考 `../mono-demo-273` 的数据库分层方式。
2. 如果要参考，SQLite 版本应该如何落地。
3. 如何做到：
   - 一张表一个 schema 文件
   - Atlas 管 schema 和 migration
   - Drizzle 生成 `schema.sessions` 这种 TypeScript 导出
   - 服务端运行时正确设置 SQLite PRAGMA

## 2. 结论

可以，而且建议这么做。

但需要明确分成三层：

1. `packages/db`
   数据库结构 source of truth，只放 Atlas HCL 和 migrations。
2. `packages/orm`
   从数据库 introspect 生成的 Drizzle schema，只给 TypeScript 查询层使用。
3. `apps/server/src/db`
   运行时数据库连接、PRAGMA、Drizzle `db` 实例。

这和 `../mono-demo-273` 的分层思想一致，只是要把 PostgreSQL 版改成 SQLite 版。

## 3. 参考 `mono-demo-273` 后的适配结论

### 3.1 可以直接借鉴的部分

`../mono-demo-273` 已经有一套清晰模式：

- `packages/db/atlas.hcl`
- `packages/db/schema/*.pg.hcl`
- `packages/db/migrations/*.sql`
- `packages/orm/drizzle.config.ts`
- `packages/orm/src/schema.ts`

这套模式最大的优点是：

1. schema source of truth 和 ORM 代码分离。
2. migration 是版本化的，不会绕过 git。
3. 业务代码只 import `@.../orm`，不用自己维护一大坨手写类型。

因此，这个项目建议沿用这个模式。

### 3.2 不能照抄的部分

`mono-demo-273` 是 PostgreSQL，而你这里是 SQLite，所以有三处必须调整：

1. HCL 文件后缀从 `.pg.hcl` 改成 `.lt.hcl`
2. schema 名从 `public` 改成 `main`
3. 不使用 PostgreSQL 原生 `enum` 块

原因：

- Atlas 官方对 SQLite 的 HCL 示例使用 `schema "main"`。
- Atlas 的 `enum` 类型是 PostgreSQL 支持的能力，不适用于 SQLite。
- SQLite 的“枚举”要靠 `TEXT + CHECK (...)` 实现，而不是独立的 enum type。

参考资料：

- Atlas SQLite declarative HCL: https://atlasgo.io/getting-started/sqlite-declarative-hcl
- Atlas SQLite schema reference: https://atlasgo.io/hcl/sqlite
- Drizzle SQLite existing database introspection: https://orm.drizzle.team/docs/get-started/sqlite-existing
- Drizzle `pull`: https://orm.drizzle.team/docs/drizzle-kit-pull

## 4. 推荐目录结构

```text
packages/
├── db/
│   ├── atlas.hcl
│   ├── package.json
│   ├── README.md
│   ├── schema/
│   │   ├── _base.lt.hcl
│   │   ├── workspaces.lt.hcl
│   │   ├── sessions.lt.hcl
│   │   ├── plans.lt.hcl
│   │   ├── tasks.lt.hcl
│   │   ├── messages.lt.hcl
│   │   ├── tool-calls.lt.hcl
│   │   ├── approvals.lt.hcl
│   │   ├── artifacts.lt.hcl
│   │   └── session-events.lt.hcl
│   └── migrations/
│       └── atlas.sum
├── orm/
│   ├── package.json
│   ├── tsconfig.json
│   ├── drizzle.config.ts
│   └── src/
│       ├── schema.ts
│       ├── relations.ts
│       └── index.ts
apps/
└── server/
    └── src/
        └── db/
            ├── client.ts
            └── pragmas.ts
```

## 5. 每一层的职责

### 5.1 `packages/db`

职责：

- Atlas HCL schema source of truth
- 版本化 migration
- schema review 的主要位置

不负责：

- TypeScript ORM
- 运行时数据库连接
- 仓库业务逻辑

### 5.2 `packages/orm`

职责：

- 保存 Drizzle introspect 生成的 `schema.ts`
- 暴露 `schema.sessions`、`schema.tasks`、`schema.toolCalls`
- 作为前后端共享的数据访问结构层

不负责：

- migration
- schema source of truth
- PRAGMA

### 5.3 `apps/server/src/db`

职责：

- 打开 SQLite 文件
- 执行 PRAGMA
- 初始化 Drizzle `db`
- 给 service/repository 提供可用连接

不负责：

- 手写表结构

## 6. `_base.lt.hcl` 和 `_enums.lt.hcl` 怎么处理

### 6.1 `_base.lt.hcl`

建议保留，而且很有用。

文件内容建议类似：

```hcl
schema "main" {
  comment = "OpenCode Web Lite 应用主 Schema"
}
```

作用：

- 统一 schema 命名
- 与 `mono-demo-273/packages/db/schema/_base.pg.hcl` 的职责一致
- 以后所有表都引用 `schema.main`

### 6.2 `_enums.lt.hcl`

不建议做成 Atlas 可执行 schema 文件。

原因：

1. SQLite 没有 PostgreSQL 那种原生 enum type。
2. Atlas 的 `enum` block 是 PostgreSQL 特性，不适用于 SQLite。
3. 真正生效的约束仍然必须写回各张表自己的 `CHECK (...)`。

因此，SQLite 下推荐这样做：

1. 不创建 `_enums.lt.hcl`
2. 每张表把自己的状态字段用 `TEXT + CHECK (...)` 约束死

例如：

```hcl
column "status" {
  type = text
  null = false
}

check "sessions_valid_status" {
  expr = "status IN ('planning', 'executing', 'waiting_approval', 'blocked', 'failed', 'completed', 'archived')"
}
```

如果你特别想保留和 `mono-demo-273` 一致的视觉结构，可以额外建一个非 HCL 文件：

- `packages/db/schema/_enums.md`

它只做“状态字典说明”，不参与 Atlas 执行。  
真正的 source of truth 仍然是各表里的 `CHECK`。

## 7. 每张表文件里放什么

建议一张表一个 HCL 文件，并且把这张表的索引和约束全部放在同一个文件里。

例如 `sessions.lt.hcl`：

```hcl
table "sessions" {
  schema = schema.main

  column "id" {
    type = text
    null = false
  }

  column "workspace_id" {
    type = text
    null = false
  }

  column "title" {
    type = text
    null = false
  }

  column "goal_text" {
    type = text
    null = false
  }

  column "status" {
    type = text
    null = false
  }

  column "created_at" {
    type = text
    null = false
  }

  column "updated_at" {
    type = text
    null = false
  }

  primary_key {
    columns = [column.id]
  }

  foreign_key "sessions_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_delete   = CASCADE
  }

  check "sessions_valid_status" {
    expr = "status IN ('planning', 'executing', 'waiting_approval', 'blocked', 'failed', 'completed', 'archived')"
  }

  index "idx_sessions_workspace_updated_at" {
    columns = [column.workspace_id, column.updated_at]
  }

  index "idx_sessions_status" {
    columns = [column.status]
  }
}
```

原则：

1. 表定义、外键、check、unique、index 全放一起。
2. 不单独搞一个全局 `indexes.lt.hcl`。
3. 以后 review 某张表时，只看一个文件就够。

## 8. 索引放在哪里

索引建议直接写在对应表的 HCL 文件里，不要单独拆出去。

原因：

1. 可读性最好。
2. schema review 最直接。
3. 和 `mono-demo-273` 的做法一致。

例子：

- `sessions.lt.hcl` 里放 `sessions` 的索引
- `tasks.lt.hcl` 里放 `tasks` 的索引
- `session-events.lt.hcl` 里放 `session_events` 的索引

## 9. PRAGMA 放在哪里

这些 PRAGMA：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
```

不应该放在 Atlas HCL，也不应该放在 migration SQL。

它们应该放在运行时数据库连接初始化里。

推荐文件：

- [apps/server/src/db/pragmas.ts](/home/daohaosisi/dev/OpenCode-Web-Lite-MVP/apps/server/src/db/pragmas.ts)
- [apps/server/src/db/client.ts](/home/daohaosisi/dev/OpenCode-Web-Lite-MVP/apps/server/src/db/client.ts)

推荐职责：

`pragmas.ts`

```ts
import type Database from 'better-sqlite3';

export function applySqlitePragmas(db: Database) {
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
}
```

`client.ts`

```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { applySqlitePragmas } from './pragmas.js';

const sqlite = new Database(
  process.env.DATABASE_PATH ?? './apps/server/data/opencode.db'
);
applySqlitePragmas(sqlite);

export const db = drizzle(sqlite);
export { sqlite };
```

原因：

1. `foreign_keys = ON` 是连接级行为，必须在连接初始化时设置。
2. `journal_mode = WAL` 和 `synchronous = NORMAL` 是运行策略，不属于 schema。
3. PRAGMA 的职责是“数据库运行配置”，不是“数据库结构定义”。

## 10. 推荐工具链

### 10.1 Schema 和 migration

用 Atlas。

原因：

1. 你明确想要 `packages/db/schema/*.hcl` 这种一张表一个文件的结构。
2. 你已经习惯 `mono-demo-273` 这种 schema-first 工作流。
3. Atlas 很适合做 versioned migration。

### 10.2 ORM / TypeScript schema

用 Drizzle introspection。

原因：

1. 可以从 SQLite 数据库直接生成 TypeScript schema。
2. 最终可以得到 `schema.sessions` 这种导出。
3. 业务代码不需要再维护一份手写表定义。

### 10.3 SQLite driver

推荐 `better-sqlite3`。

原因：

1. 本地 Node 场景最直接。
2. 同步 API 适合本项目当前体量。
3. 和 Drizzle 官方 SQLite 驱动兼容。

## 11. 推荐 package 结构和脚本

### 11.1 `packages/db/package.json`

建议只放元信息和脚本，不放业务依赖。

建议脚本：

```json
{
  "name": "@opencode/db",
  "private": true,
  "scripts": {
    "diff": "atlas migrate diff",
    "apply": "atlas migrate apply --env local",
    "status": "atlas migrate status --env local",
    "lint": "atlas migrate lint --env local --latest 1"
  }
}
```

### 11.2 `packages/orm/package.json`

建议脚本：

```json
{
  "name": "@opencode/orm",
  "private": true,
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "introspect": "drizzle-kit pull --config drizzle.config.ts && pnpm format:schema",
    "format:schema": "prettier --write src/schema.ts src/relations.ts"
  }
}
```

说明：

- 这里的命令名仍然可以叫 `introspect`
- 但 SQLite 下实际执行的建议命令是 `drizzle-kit pull`
- 这是 Drizzle 官方对 existing database 的推荐路径

## 12. `atlas.hcl` 的推荐形态

建议做一个 SQLite 版本，保持和 `mono-demo-273/packages/db/atlas.hcl` 的组织方式接近。

示例：

```hcl
variable "db_url" {
  type    = string
  default = getenv("DATABASE_URL")
}

env "local" {
  url = var.db_url
  dev = "sqlite://dev?mode=memory"

  src = [
    "file://schema"
  ]

  migration {
    dir = "file://migrations"
  }

  lint {
    destructive {
      error = false
    }

    data_depend {
      error = false
    }
  }

  format {
    migrate {
      diff = "{{ sql . }}"
    }
  }
}
```

说明：

1. `dev = "sqlite://dev?mode=memory"` 是 SQLite 下很自然的 dev 数据库配置。
2. 当前项目先不需要 `pro-schema/`。
3. 等以后真的引入 trigger 或其他高级对象，再单独加目录。

## 13. `packages/orm/drizzle.config.ts` 的推荐形态

建议：

```ts
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './src',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'sqlite://./apps/server/data/opencode.db'
  },
  introspect: {
    casing: 'camel'
  },
  verbose: true,
  strict: true
});
```

说明：

1. `out: './src'` 可以让生成结果直接进 `packages/orm/src/`
2. `casing: 'camel'` 让 TS 导出风格更符合当前代码库
3. 最终会生成类似：
   - `schema.ts`
   - `relations.ts`

## 14. 服务端的最终使用方式

目标就是你要的这种：

```ts
import { db } from '../db/client.js';
import * as schema from '@opencode/orm';

const sessions = await db.select().from(schema.sessions);
```

这意味着：

1. 运行时连接在 `apps/server/src/db/client.ts`
2. schema 导出在 `packages/orm`
3. server 不再手写一套表定义

## 15. 开发工作流

推荐采用 versioned migration，不建议把 `atlas schema apply` 当日常主流程。

### 15.1 日常主流程

1. 修改 `packages/db/schema/*.lt.hcl`
2. 生成 migration
3. 检查 migration SQL
4. 应用 migration
5. 运行 Drizzle introspection
6. 在代码里使用新的 `schema.*`

### 15.2 推荐命令

```bash
# 1. 修改 schema 文件
vim packages/db/schema/sessions.lt.hcl

# 2. 生成 migration
cd packages/db
atlas migrate diff add_sessions_table --env local

# 3. 检查 migration
sed -n '1,240p' migrations/$(ls -t migrations/*.sql | head -1)

# 4. 应用 migration
atlas migrate apply --env local

# 5. 同步 ORM schema
cd ../orm
pnpm introspect
```

### 15.3 什么时候用 `atlas schema apply`

只建议在下面两种场景使用：

1. 早期探索 schema 时做临时验证
2. 一次性把 RFC 里的初版 schema 快速打到空库里做试验

一旦进入正式开发，建议切回：

1. `atlas migrate diff`
2. `atlas migrate apply`

原因：

- migration 要进 git
- 团队 review 更清楚
- 未来回放和回滚成本更低

## 16. 推荐实施步骤

### 第 0 步：搭工具骨架

新增：

1. `packages/db`
2. `packages/orm`
3. `apps/server/src/db/pragmas.ts`

安装依赖：

1. `better-sqlite3`
2. `drizzle-orm`
3. `drizzle-kit`
4. `@types/better-sqlite3`

外部工具：

1. Atlas CLI

### 第 1 步：建立 `packages/db`

创建：

1. `packages/db/atlas.hcl`
2. `packages/db/schema/_base.lt.hcl`
3. `packages/db/schema/*.lt.hcl`
4. `packages/db/migrations/`

这个阶段先不写业务代码，只把 schema source of truth 立起来。

### 第 2 步：先写初版九张表

按 RFC 里的范围写：

1. `workspaces`
2. `sessions`
3. `plans`
4. `tasks`
5. `messages`
6. `tool_calls`
7. `approvals`
8. `artifacts`
9. `session_events`

并把各自索引也写进对应文件。

### 第 3 步：生成初始 migration

执行：

```bash
cd packages/db
atlas migrate diff init_schema --env local
atlas migrate apply --env local
```

同时提交：

1. 首个 migration SQL
2. `atlas.sum`

### 第 4 步：建立 `packages/orm`

创建：

1. `packages/orm/drizzle.config.ts`
2. `packages/orm/src/index.ts`

然后运行：

```bash
cd packages/orm
pnpm introspect
```

拿到：

1. `src/schema.ts`
2. `src/relations.ts`

### 第 5 步：改 `apps/server/src/db/client.ts`

把现在的占位 client：

- 从“只返回路径和 ready=false”

改成：

- 真正打开 SQLite
- 应用 PRAGMA
- 初始化 Drizzle

### 第 6 步：Repository / Service 改造

把现在内存 Map 服务逐步替换成数据库访问：

1. `workspace-service`
2. `session-service`
3. `approval-service`
4. 新增 `plan-service`
5. 新增 `task-service`
6. 新增 `event-service`

### 第 7 步：再接 SSE 和 resume

在数据已经稳定落库之后，再做：

1. `session_events` 驱动 timeline
2. reconnect 基于 `sequence_no`
3. resume 基于 `sessions.current_task_id + last_checkpoint_json`

## 17. 推荐的首批 PR 切分

建议不要把所有事情揉成一个超大 PR。

### PR 1：数据库工具链

包含：

1. `packages/db`
2. `packages/orm`
3. Atlas / Drizzle / better-sqlite3 依赖
4. `apps/server/src/db/client.ts` 和 `pragmas.ts` 骨架

不碰业务 service。

### PR 2：初始 schema 和 migration

包含：

1. 九张表 HCL
2. 初始 migration
3. 生成的 `packages/orm/src/schema.ts`

### PR 3：server 持久化接入

包含：

1. session/workspace/message/tool_call/approval 持久化替换
2. plan/task/event/artifact service 初版

### PR 4：timeline / resume 联通

包含：

1. `session_events` 回放
2. checkpoint 恢复
3. 前端对接

## 18. 几个关键取舍

### 18.1 要不要用 Atlas HCL

建议用。

因为你要的不是“只要能跑”，而是：

1. 一张表一个文件
2. 结构清晰
3. schema review 清楚
4. 未来能稳定产出 migration

这正是 Atlas HCL 的强项。

### 18.2 要不要手写 Drizzle schema

不建议。

因为你已经决定 schema source of truth 在 `packages/db`。

如果再手写一份 Drizzle schema，就会出现两份结构定义：

1. Atlas HCL
2. Drizzle TS

长期一定漂移。

因此建议：

- Atlas HCL 是真源
- Drizzle schema 全部 introspect 生成

### 18.3 要不要保留 `_enums.lt.hcl`

不建议。

SQLite 下它不会像 PostgreSQL 那样真正定义 enum type。  
如果保留，只会制造“看起来有统一枚举、实际上约束散落各表”的错觉。

最干净的做法仍然是：

1. `_base.lt.hcl` 保留
2. `_enums.lt.hcl` 不建
3. 状态枚举在表级 `CHECK` 中约束

## 19. 我建议你确认的最终方案

如果按我推荐的路线，最后的方案是：

1. 参考 `../mono-demo-273` 的三层结构
2. 但数据库方言改成 SQLite
3. 使用 `packages/db/schema/*.lt.hcl`
4. 保留 `_base.lt.hcl`
5. 不创建 `_enums.lt.hcl`
6. PRAGMA 放到 `apps/server/src/db/pragmas.ts`
7. 日常工作流使用 `atlas migrate diff` + `atlas migrate apply`
8. `packages/orm` 用 Drizzle introspect 生成 `schema.*`

## 20. 下一步建议

如果你认可这份实施方案，下一步不要先碰业务代码，而是先做下面这一批基础设施：

1. 建 `packages/db`
2. 建 `packages/orm`
3. 安装 Atlas/Drizzle/SQLite 依赖
4. 写 `atlas.hcl`
5. 写 `_base.lt.hcl`
6. 先把九张表的 HCL 落下去

完成这一步后，再生成首个 migration 和 ORM schema。

## 21. 参考路径

本方案主要参考了以下本地实现：

- [../mono-demo-273/packages/db/atlas.hcl](/home/daohaosisi/dev/mono-demo-273/packages/db/atlas.hcl)
- [../mono-demo-273/packages/db/schema/\_base.pg.hcl](/home/daohaosisi/dev/mono-demo-273/packages/db/schema/_base.pg.hcl)
- [../mono-demo-273/packages/db/schema/\_enums.pg.hcl](/home/daohaosisi/dev/mono-demo-273/packages/db/schema/_enums.pg.hcl)
- [../mono-demo-273/packages/db/schema/conversations.pg.hcl](/home/daohaosisi/dev/mono-demo-273/packages/db/schema/conversations.pg.hcl)
- [../mono-demo-273/packages/orm/drizzle.config.ts](/home/daohaosisi/dev/mono-demo-273/packages/orm/drizzle.config.ts)
- [../mono-demo-273/packages/orm/src/schema.ts](/home/daohaosisi/dev/mono-demo-273/packages/orm/src/schema.ts)
