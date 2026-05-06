# AGENTS.md

这个文件给在本仓库工作的编码 agent 提供项目背景、常用命令和架构边界。

## 常用命令

```bash
# 安装依赖，必须在仓库根目录执行
pnpm install

# 开发
pnpm dev:web        # 启动前端：http://localhost:5173
pnpm dev:server     # 启动后端：http://localhost:3001，watch 模式

# 全仓库质量检查
pnpm typecheck      # TypeScript 类型检查
pnpm lint           # ESLint
pnpm test           # server 单测
pnpm format         # Prettier 格式化
pnpm format:check   # 检查格式化
pnpm build          # 构建所有 package

# 数据库
pnpm db:apply       # 应用本地 SQLite migration
pnpm db:status      # 查看 migration 状态
pnpm db:sync        # 从数据库同步 ORM schema
```

单包检查可使用 `pnpm --filter <package> <script>`，例如：

```bash
pnpm --filter @opencode/server typecheck
pnpm --filter @opencode/server test
pnpm --filter @opencode/agent typecheck
pnpm --filter @opencode/web typecheck
```

## 项目定位

这是一个 **pnpm monorepo**，目标是实现轻量版 AI Agent Web Console。前端提供会话、时间线、任务面板、详情面板和审批交互；后端负责会话持久化、SSE 事件流、模型调用、工具执行、审批暂停与恢复。

当前主线不是旧的单文件 runtime，也不是模拟模型客户端。有效源码以 `packages/agent` 的 `Lifecycle`、`RunLoop`、`SessionProcessor` 和 server 侧的 `SessionInteractionService`、`SessionRunner`、`wiring/agent.ts` 为准。

## 目录结构

```text
apps/web/          React 19 + Vite + TanStack Router + TailwindCSS 前端
apps/server/       Hono REST + SSE 后端，负责 API、持久化、provider adapter、runtime wiring
packages/agent/    Agent 执行内核：上下文构建、运行循环、流处理、工具、审批恢复
packages/shared/   前后端共享 DTO、事件、contract、工具类型
packages/orm/      Drizzle ORM schema
packages/db/       Atlas migration schema 和 SQL migrations
```

## 主链路

用户提交消息后的链路：

```text
Composer
  -> POST /api/sessions/:sessionId/messages
  -> SessionInteractionService.prompt()
  -> SessionRunner.ensureRunning(...)
  -> Lifecycle.startPromptRun(...)
  -> RunLoop.run(...)
  -> ContextBuilder + modelFactory
  -> SessionProcessor.processTurn(...)
  -> streamModelResponse() / AI SDK streamText
  -> message、tool、approval、session event 持久化
  -> sessionStreamHub live publish
  -> GET /api/sessions/:sessionId/stream SSE
```

审批恢复链路：

```text
POST /api/approvals/:approvalId/approve 或 reject
  -> SessionInteractionService.resolveApproval()
  -> SessionRunner.ensureRunning(...)
  -> Lifecycle.resumeApprovalRun(...)
  -> 执行或拒绝工具结果
  -> RunLoop.run(...) 继续模型轮次
```

## 模型接入

模型通过 AI SDK 接入，当前 server wiring 使用：

```text
apps/server/src/services/ai/provider.ts
apps/server/src/services/ai/response-stream.ts
packages/agent/src/model-client.ts
```

`createLanguageModel()` 使用 `@ai-sdk/openai` 创建 OpenAI-compatible provider。常用环境变量：

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=...
OPENAI_BASE_URL=...      # 可选，兼容自定义网关
HTTPS_PROXY=...          # 可选，也支持 HTTP_PROXY / 小写变量
DATABASE_PATH=...
```

## 关键类型

共享类型位于 `packages/shared`。

主要 DTO：`SessionDto`、`MessageDto`、`ToolCallDto`、`ApprovalDto`、`AgentRunDto`。

主要事件：`SessionEvent` 和带序号的 session event envelope。SSE 支持历史 replay 和 live fan-out。

内置工具：`read_file` 可直接执行，`write_file` 和 `run_command` 需要审批。

## 前端结构

三栏工作台主要定义在 `apps/web/src/router.tsx`。

左侧是 `SessionList`，负责 workspace 和 session 切换。

中间是 `TaskBoard`、`TimelinePanel` 和 `Composer`。

右侧是 `DetailPane`，展示文件预览、diff、approval UI 和命令输出。

`apps/web/src/hooks/use-session-stream.ts` 使用 `EventSource` 订阅 `GET /api/sessions/:sessionId/stream`，并消费后端 SSE envelope。

## 后端结构

`apps/server/src/app.ts` 组装 Hono routes。

HTTP 层在 `apps/server/src/routes`，只负责参数校验、调用 service、返回 JSON/SSE。

业务编排在 `apps/server/src/services`，包括 session、agent、session-events、workspace、ai 等领域。

持久化通过 `apps/server/src/repositories` 访问 SQLite，schema 来源在 `packages/db` 和 `packages/orm`。

Agent runtime 的依赖装配在 `apps/server/src/wiring/agent.ts`，这里把 `packages/agent` 的抽象 deps 接到 server 的真实 service、repository、model provider。

## 设计系统

自定义 Tailwind 主题在 `apps/web/tailwind.config.ts`。

颜色包括 `ink`、`mist`、`sand`、`ember`、`pine`。

字体在 `apps/web/src/styles.css` 中从 Google Fonts 加载，主要使用 Space Grotesk 和 IBM Plex Sans。

## 当前状态

已接通的主能力：SQLite 持久化、session/message/event repository、SSE replay + live、AI SDK OpenAI-compatible provider、流式 assistant 消息、内置工具、审批暂停/恢复、取消当前 run、server 单测。

仍在演进的方向：真实任务/计划数据接入 `TaskBoard`、compact/context pruning、启动时进程恢复、更完整的 provider 能力过滤、更多工具与 UI 细节。
