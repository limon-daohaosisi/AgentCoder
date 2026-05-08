# OpenCode Web Lite MVP

轻量版 AI Agent Web Console 的 pnpm monorepo。前端提供会话、时间线、任务面板、详情面板和审批交互；后端负责 SQLite 持久化、SSE 事件流、AI SDK 模型调用、工具执行和审批恢复。

## 目录

```text
apps/
  web/       React 19 + Vite + TanStack Router 工作台
  server/    Hono REST + SSE + SQLite + AI provider adapter
packages/
  agent/     Agent 执行内核：上下文、RunLoop、SessionProcessor、工具和审批恢复
  shared/    前后端共享 DTO、事件、contract、工具类型
  orm/       Drizzle ORM schema
  db/        Atlas migration schema 和 SQL migrations
```

## 开发命令

```bash
pnpm install
pnpm dev:web
export OPENAI_BASE_URL="https://code.contextid.cn/v1"
export OPENAI_API_KEY="sk-xxx"
export OPENAI_MODEL="gpt-5.4"
DATABASE_URL="sqlite://../../apps/server/data/opencode.db" pnpm db:apply
DATABASE_PATH=./data/opencode.db pnpm dev:server
```

## 当前状态

- 已接通 SQLite 持久化、session/message/event repository、SSE replay + live fan-out
- 已通过 AI SDK 和 `@ai-sdk/openai` 接入 OpenAI-compatible provider
- Agent 主链路以 `packages/agent` 的 `Lifecycle`、`RunLoop`、`SessionProcessor` 为核心
- 已支持流式 assistant 消息、内置工具、审批暂停/恢复、取消当前 run 和 server 单测
- 仍在演进：真实任务/计划数据接入 `TaskBoard`、compact/context pruning、启动时进程恢复和更多工具/UI 细节
