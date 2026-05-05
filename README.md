# OpenCode Web Lite MVP

根据 [`opencode-web-lite-mvp.md`](opencode-web-lite-mvp.md) 搭出的 monorepo 骨架，先把 Web、Server、共享类型和 agent core 的基础结构建好，后续可以直接往里填业务实现。

## 目录

```text
apps/
  web/       React + Vite + TanStack Router 工作台骨架
  server/    Hono + SSE + 本地能力占位实现
packages/
  shared/    前后端共享 DTO、事件、工具类型
  agent-core system prompt、tool registry、loop 类型
```

## 开发命令

```bash
pnpm install
pnpm dev:web
export OPENAI_BASE_URL="https://code.contextid.cn/v1"
export OPENAI_API_KEY="sk-xxx"
export OPENAI_MODEL="gpt-5.4"
DATABASE_PATH=./data/opencode.db pnpm dev:server
```

## 当前状态

- 已建好 monorepo 结构和工作区配置
- 已建好 Web 三栏工作台页面骨架
- 已建好 Server 路由、服务、agent 和 tool 目录
- 共享类型、事件模型、工具 schema 已整理到 `packages/shared` 和 `packages/agent-core`
- 数据库、模型接入、真正的审批流和会话恢复还没有接通
