# OpenCode Web Lite MVP

`OpenCode Web Lite MVP` 是一个本地优先、session-first 的 AI Agent Web Console monorepo。它不是把聊天框搬进网页，而是把一次复杂目标的 `workspace -> session -> plan -> task -> tool -> approval -> event` 执行链路做成可持久化、可恢复、可回放的控制台。

当前实现已经覆盖工作区选择、会话持久化、计划板、流式时间线、工具审批、会话回滚/恢复、启动恢复和只读探索型 subagent。前端基于 React 19 + Vite，后端基于 Hono + SQLite，模型接入通过 AI SDK 与 OpenAI-compatible provider 完成。

## Design Goals

- 本地优先：围绕本地 workspace 工作，而不是围绕云端项目元数据工作。
- durable by default：session、message、tool call、approval、event、plan、task 都有持久化语义，不依赖前端内存状态。
- inspectable runtime：用户可以看到任务板、时间线、审批、diff、命令输出和恢复状态，而不只是 assistant 文本。
- safe mutation：高风险动作默认走审批，文件与命令执行受 workspace 边界和非交互限制保护。

## Features

- Workspace-first 入口：支持目录选择器、最近工作区列表、目录浏览，以及对已有 workspace 的复用。
- Session-first 执行模型：SQLite 持久化 session、agent run、message、message part、tool call、approval、session event、plan、task 等核心状态。
- Planning-to-execution 工作流：会话支持 `plan` / `build` 变体，具备计划文件、真实任务板、当前任务指针和 `plan_exit` 审批流。
- 实时时间线：后端通过 SSE 提供历史 replay + live fan-out，前端通过 `EventSource` 持续消费增量事件。
- 流式 agent 运行：支持 assistant 文本、reasoning、tool call、tool result 的持续写入与展示。
- 工具体系：内置 `read`、`glob`、`grep`、任务工具、`batch`、`agent`、`apply_patch`、`bash`、`write`、`edit`、`plan_exit`。
- 审批暂停与恢复：需要审批的工具会把 run durable 地暂停在 checkpoint，审批通过或拒绝后继续执行。
- 运行控制：支持取消当前 run、手动 compact、刷新后 resume 状态查询。
- 会话回滚：支持按 message 回滚工作区快照，并支持恢复这次回滚。
- 启动恢复：server 启动时会扫描中断 run 和 stale session，自动恢复或阻塞并写入诊断事件。
- Explore subagent：支持创建只读的 `explore` 子会话，用于代码库调研与总结。

## Tech Stack

- Frontend: React 19, Vite, TanStack Router, TanStack Query, Tailwind CSS
- Backend: Hono, Node.js, better-sqlite3, Drizzle ORM
- Agent Runtime: custom `packages/agent` runtime built around `Lifecycle`, `RunLoop`, `SessionProcessor`
- Model Integration: AI SDK + `@ai-sdk/openai`
- Database Schema: Atlas migrations + Drizzle schema sync

## Running Locally

前提条件：

- Node.js 当前 LTS 版本，推荐 Node.js 22。
- `pnpm` 10.6.0 或更高版本。
- Atlas CLI，`pnpm db:apply` / `pnpm db:status` 依赖它。
- 一个可用的 OpenAI-compatible API key。

仓库现在会在几个主要入口自动加载仓库根目录的 `.env.local` 和 `.env`：

- `pnpm dev:server`
- `pnpm db:apply`
- `pnpm db:status`
- `pnpm db:sync`

推荐先复制一份环境变量模板：

```bash
cp .env.example .env
pnpm install

pnpm db:apply
pnpm dev:server
pnpm dev:web
```

如果你不想使用 `.env` 文件，也仍然可以在 shell 里显式 `export` 这些变量覆盖默认值。

启动后：

- Web: `http://localhost:5173`
- Server: `http://localhost:3001`
- Health Check: `http://localhost:3001/health`

如果你需要代理访问模型服务，也可以设置：

- `HTTPS_PROXY`
- `HTTP_PROXY`
- 小写形式的 `https_proxy` / `http_proxy`

## Environment Variables

| Variable                     | Required                                   | Used By                         | Notes                                                                  |
| ---------------------------- | ------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------- |
| `OPENAI_API_KEY`             | Yes                                        | server runtime                  | OpenAI-compatible provider 凭证                                        |
| `OPENAI_MODEL`               | No                                         | server runtime, prompt defaults | 默认值为 `gpt-4.1-mini`                                                |
| `OPENAI_BASE_URL`            | No                                         | server runtime                  | 自定义网关或兼容 OpenAI 的 base URL                                    |
| `DATABASE_PATH`              | No                                         | server runtime, `pnpm db:sync`  | 默认值为 `./apps/server/data/opencode.db`                              |
| `DATABASE_URL`               | Yes for `pnpm db:apply` / `pnpm db:status` | Atlas migration scripts         | 从仓库根目录执行时，使用 `sqlite://../../apps/server/data/opencode.db` |
| `PORT`                       | No                                         | server runtime                  | 默认 `3001`                                                            |
| `HTTPS_PROXY` / `HTTP_PROXY` | No                                         | model provider fetch            | 模型请求代理                                                           |

`.env` 示例：

```bash
OPENAI_API_KEY=sk-xxx
OPENAI_MODEL=gpt-5.4
OPENAI_BASE_URL=https://your-openai-compatible-endpoint
DATABASE_PATH=./data/opencode.db
DATABASE_URL=sqlite://../../apps/server/data/opencode.db
```

## Common Commands

```bash
pnpm dev:web
pnpm dev:server

pnpm typecheck
pnpm lint
pnpm test
pnpm build

pnpm format
pnpm format:check

pnpm db:apply
pnpm db:status
pnpm db:sync
```

单包检查也可直接运行：

```bash
pnpm --filter @opencode/server typecheck
pnpm --filter @opencode/server test
pnpm --filter @opencode/agent typecheck
pnpm --filter @opencode/web typecheck
```

## Runtime Flow

用户提交消息后的主链路：

```text
Composer
  -> POST /api/sessions/:sessionId/messages
  -> SessionInteractionService.prompt()
  -> SessionRunner.ensureRunning(...)
  -> Lifecycle.startPromptRun(...)
  -> RunLoop.run(...)
  -> ContextBuilder + modelFactory
  -> SessionProcessor.processTurn(...)
  -> tool execution / approval pause / streaming message persistence
  -> append durable session events
  -> GET /api/sessions/:sessionId/stream SSE replay + live fan-out
```

审批恢复链路：

```text
POST /api/approvals/:approvalId/approve or reject
  -> SessionInteractionService.resolveApproval()
  -> SessionRunner.ensureRunning(...)
  -> Lifecycle.resumeApprovalRun(...)
  -> execute or reject approved tool result
  -> RunLoop.run(...) continues next model turns
```

启动恢复链路：

```text
server boot
  -> sessionRecoveryService.recoverInterruptedSessionsOnStartup()
  -> inspect open runs / waiting approvals / stale sessions
  -> recover, keep waiting approval, or block with diagnostics
  -> publish recovery events back to the session stream
```

## Tool Model

| Category                 | Tools                                                                                | Approval     |
| ------------------------ | ------------------------------------------------------------------------------------ | ------------ |
| Read-only                | `read`, `glob`, `grep`                                                               | Not required |
| Workflow / orchestration | `task_create`, `task_list`, `task_get`, `task_update`, `task_stop`, `batch`, `agent` | Not required |
| Mutating / risky         | `apply_patch`, `bash`, `write`, `edit`, `plan_exit`                                  | Required     |

额外约束：

- `bash` 只允许在 workspace 内执行，并拒绝 `vim`、`less`、`top` 这类交互式命令。
- `write`、`edit`、`apply_patch` 会基于文件快照和 diff 构建审批载荷，避免对陈旧内容盲写。
- `plan_exit` 只允许在 `plan` 模式下触发，用于把当前计划文件提交给用户确认。
- `explore` subagent 只暴露只读探索工具：`batch`、`read`、`glob`、`grep`。

## HTTP Surface

- `GET /health`
- `GET /api/workspaces`
- `POST /api/workspaces`
- `GET /api/workspaces/browse`
- `GET /api/workspaces/:workspaceId/tree`
- `GET /api/sessions?workspaceId=...`
- `POST /api/sessions`
- `GET /api/sessions/:sessionId`
- `GET /api/sessions/:sessionId/messages`
- `GET /api/sessions/:sessionId/plan-board`
- `GET /api/sessions/:sessionId/plan-file`
- `POST /api/sessions/:sessionId/resume`
- `POST /api/sessions/:sessionId/messages`
- `POST /api/sessions/:sessionId/compact`
- `POST /api/sessions/:sessionId/runs/current/cancel`
- `POST /api/sessions/:sessionId/revert`
- `POST /api/sessions/:sessionId/revert/restore`
- `GET /api/sessions/:sessionId/stream`
- `POST /api/approvals/:approvalId/approve`
- `POST /api/approvals/:approvalId/reject`

## Repository Layout

```text
apps/
  web/       React 19 + Vite 工作台，包含 SessionList、TaskBoard、Timeline、Composer、DetailPane
  server/    Hono REST + SSE + SQLite，负责 API、持久化、provider adapter、runtime wiring
packages/
  agent/     Agent 执行内核：context、RunLoop、SessionProcessor、tool executor、approval resume
  shared/    前后端共享 DTO、contract、session event、工具类型
  orm/       Drizzle ORM schema 与 introspect 脚本
  db/        Atlas schema 与 SQL migrations
docs/        RFC、实现方案、演进记录
```

## Current Status

已经落地：

- SQLite 持久化和 server 单测链路。
- workspace / session / message / session event 基础 CRUD 与流式订阅。
- SSE 历史 replay + live fan-out。
- AI SDK OpenAI-compatible provider 接入。
- assistant 流式文本、reasoning、tool call、tool result 持久化。
- 真实 TaskBoard 数据、计划文件工作流和 `plan_exit` 审批。
- 手动 compact、context budget 防护与自动 compact 路径。
- run 取消、approval pause/resume、session revert/restore。
- server 启动恢复 interrupted runs 和 stale sessions。
- 只读 `explore` subagent 与并行 batch 调度。

仍在演进：

- 更多内置 subagent 类型，而不只是一种 `explore`。
- 更完整的 provider 能力过滤与模型能力建模。
- 更丰富的工具集、detail pane 展示和时间线细节。
- 更长期的恢复、compact 和运行时运维能力打磨。

## Docs

- `docs/opencode-web-lite-mvp.md`：项目目标、定位和演进背景。
- `docs/2026-05-14 rfc-plan-file-and-plan-exit-workflow.md`：计划文件与 `plan_exit` 工作流。
- `docs/2026-05-29 rfc-explore-subagent-execution.md`：`explore` subagent 设计与执行方案。
- `docs/2026-05-06 rfc-session-status-and-process-recovery.md`：session 状态与启动恢复设计。

如果你是从代码入口开始读，建议优先看这些文件：

- `packages/agent/src/lifecycle.ts`
- `packages/agent/src/run-loop.ts`
- `packages/agent/src/session-processor.ts`
- `apps/server/src/services/agent/interaction-service.ts`
- `apps/server/src/services/session/recovery-service.ts`
- `apps/web/src/router.tsx`
