# RFC: OpenCode Web Lite MVP SQLite Schema

Status: Draft

Owner: Codex

Last Updated: 2026-03-30

## 1. 背景

根据 [docs/opencode-web-lite-mvp.md](./opencode-web-lite-mvp.md) 的产品定义，这个项目的主对象不是单条聊天消息，而是一条完整的执行链：

`workspace -> session -> plan -> task -> message/tool_call/approval -> event -> artifact`

MVP 需要同时满足四类能力：

1. 会话恢复：刷新、失败、中断后可以继续。
2. 执行回放：Timeline 不是前端拼出来的临时视图，而是后端可重建的结构化历史。
3. 审批护栏：`write_file` / `run_command` 需要显式记录请求、决策和结果。
4. 关键产物查看：diff、stdout、stderr、error summary、final result 要有稳定数据源。

当前仓库已有最小内存模型和占位 SQLite schema，但只覆盖了 `workspaces / sessions / messages / tool_calls / approvals`，还不足以支撑 plan board、task board、timeline replay 和 resume。

## 2. 外部调研结论

这部分只记录和本项目 schema 设计直接相关的结论。

### 2.1 OpenAI Agents SDK

- 基础 `SQLiteSession` 只有两张核心表：`sessions` 和 `messages`，它解决的是“会话上下文记忆”而不是 agent work console 的执行建模。
- `SQLiteSession` 显式开启 `WAL`，并给 `messages(session_id, id)` 建索引，说明 SQLite 非常适合本地会话场景。
- `AdvancedSQLiteSession` 没有推翻基础表，而是在其上增加 `message_structure` 和 `turn_usage`，用于结构化查询、分支和 usage analytics。

对本项目的启发：

- `messages` 必须保留，但它只能作为基础上下文层。
- Timeline、Task Board、审批和恢复能力不能依赖 `messages` 反推，必须有单独结构化表。
- usage / branching 这种分析型能力可以作为第二阶段增量表，而不是首批 schema 的中心。

### 2.2 OpenCode

- OpenCode 的权限模型不是简单二元开关，而是 `allow / ask / deny`，并且 `ask` 支持 `once / always / reject` 三种结果。
- OpenCode 的工具权限可以细化到命令前缀和路径模式，这意味着审批对象除了“这次批不批”，还天然带有“建议规则”的扩展空间。
- OpenCode 的 `/share` 会同步完整 conversation history 和 session metadata，说明可分享/可回放的前提是历史和元数据都被结构化保存。
- OpenCode 还提供 `/sessions`、`/undo`、`/redo`，而且文件变更恢复和会话切换是产品级能力，不是临时上下文。

对本项目的启发：

- `approvals` 不能只存一个最终状态，至少要存展示 payload 和可扩展的 rule suggestion。
- `sessions` 必须是真正的可恢复对象，而不是“当前聊天窗口”。
- 后续如果要做 shareable run review，`session metadata + structured history + artifacts` 都要能导出。

### 2.3 Claude Code

- Claude Code 把工具权限和路径限制放在结构化 settings 中，`allow` / `deny` 规则是持久化状态的一部分。
- Claude Code 还把项目级指令和自动记忆分开；`CLAUDE.md` 是稳定规则，auto memory 是会话学习结果。
- 文档里明确提到 `~/.claude.json` 会保存 per-project state、allowed tools、trust settings 和缓存。

对本项目的启发：

- “项目规则”和“执行历史”要分开存；本 RFC 先处理执行历史，不把 agent 配置、长期记忆和会话运行数据混在一张表里。
- 需要为将来的权限继承、workspace trust、session resume 预留干净的主键和关联关系。

### 2.4 goose

- goose 已从 `.jsonl` 迁移到单个本地 `sessions.db`。
- 官方文档明确说 `sessions.db` 保存 session metadata、conversation messages、tool calls and results、token usage、extension data。
- goose 的 Desktop 和 CLI 共享同一份数据库，session 可以跨入口恢复。
- goose 的 session export 会导出完整 conversation history、metadata 和 settings。

对本项目的启发：

- 一个本地 SQLite 文件足够承载 MVP 全部状态。
- `session` 必须是跨入口、跨 UI 恢复的稳定主键。
- tool call/result 不应只留在日志或 SSE 中，而要落到持久表里。

### 2.5 OpenHands

- OpenHands 的 WebSocket 连接要求客户端上报 `latest_event_id`，服务端基于 event id 做断线续传。
- 它的事件结构是第一类对象：每个事件有独立 id、timestamp，以及 action args/result。

对本项目的启发：

- `session_events` 必须是 append-only，并且要有可单调排序的序号。
- Timeline 回放和 SSE 重连不应依赖时间戳排序，应该依赖 `sequence_no`。

## 3. 设计目标

本 RFC 的目标是定义一版适合 MVP 的 SQLite schema，使后端可以稳定支撑：

1. 单 workspace、多 session。
2. plan draft、plan confirm、task board。
3. tool call、approval、result 持久化。
4. execution timeline 回放。
5. refresh / reconnect / resume。
6. detail pane 的 diff / stdout / stderr / error / summary 数据源。

## 4. 非目标

这版 schema 不优先解决：

1. 多 agent 并行协作。
2. 跨 session 分叉图。
3. provider 级审计或 billing。
4. 全量 prompt cache。
5. 完整长期记忆系统。

## 5. 总体设计原则

### 5.1 用“当前态表 + 事件表”双轨建模

只用事件流会让列表页和当前状态查询很痛苦；只用当前态表又会丢掉回放和恢复能力。

因此采用双轨：

- 当前态表：`sessions / plans / tasks / messages / tool_calls / approvals`
- 追加事件表：`session_events`
- 证据表：`artifacts`

### 5.2 结构化查询字段单独列，长尾数据放 JSON

适合筛选、排序、联表的字段必须单列：

- `status`
- `tool_name`
- `kind`
- `position`
- `sequence_no`
- `created_at`

变化大、结构未稳定的数据放 JSON：

- `acceptance_criteria_json`
- `content_json`
- `input_json`
- `result_json`
- `payload_json`

### 5.3 `session` 作为 MVP 的顶层执行单元，不单独引入 `runs`

当前产品定义里，一个 session 基本等价于一次复杂目标执行。为 MVP 单独引入 `session_runs` 会增加复杂度，但不会立刻换来真实收益。

结论：

- MVP 不建 `session_runs`
- “重试”“继续执行”“重新规划”先通过 `plans.version`、`tasks.status`、`session_events` 和 `artifacts` 承载
- 如果后续出现“一条 session 下有多次独立 run”的真实需求，再补 run 层

### 5.4 时间戳用于展示，顺序号用于回放

所有表仍保留 ISO-8601 UTC 的 `TEXT` 时间戳，和现有 DTO 一致。

但 Timeline / SSE replay / resume 一律以 `session_events.sequence_no` 为准，而不是 `created_at`。

## 6. 推荐表结构

### 6.1 `workspaces`

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
);
```

用途：

- 保存本地工作区根目录
- 支撑最近访问列表

说明：

- `root_path` 保持唯一，避免同一路径重复注册

### 6.2 `sessions`

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  goal_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'planning',
      'executing',
      'waiting_approval',
      'blocked',
      'failed',
      'completed',
      'archived'
    )
  ),
  current_plan_id TEXT,
  current_task_id TEXT,
  last_error_text TEXT,
  last_checkpoint_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
```

用途：

- 表示一条完整 goal 的生命周期
- 支撑 session list、resume、header 状态展示

说明：

- `current_plan_id` / `current_task_id` 先不加外键，避免 `sessions <-> plans/tasks` 循环依赖
- `last_checkpoint_json` 只保存“最近可恢复位置”的摘要，不承担完整历史

### 6.3 `plans`

```sql
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed', 'superseded')),
  summary_text TEXT,
  source TEXT NOT NULL DEFAULT 'model',
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  superseded_at TEXT,
  UNIQUE (session_id, version)
);
```

用途：

- 支撑 plan draft、plan confirm、轻量 re-plan

说明：

- `version` 解决“同一 session 多次计划”的问题
- 首版只需要线性版本，不需要 plan 分叉图

### 6.4 `tasks`

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (
    status IN (
      'todo',
      'ready',
      'running',
      'blocked',
      'waiting_approval',
      'done',
      'failed'
    )
  ),
  summary_text TEXT,
  last_error_text TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (plan_id, position)
);
```

用途：

- Task Board 主数据源
- 跟踪任务状态、顺序、摘要和失败信息

说明：

- `parent_task_id` 为未来二级任务预留，MVP 可以只用一级任务
- retry 先复用同一 task 记录，通过 event/artifact 留存历史，不首批引入 `task_attempts`

### 6.5 `messages`

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  kind TEXT NOT NULL DEFAULT 'message',
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

用途：

- 保存用户、assistant、tool 侧的消息上下文
- 支撑会话恢复时的 LLM 上下文重建

说明：

- `content_json` 直接承载当前 `MessagePart[]`
- `task_id` 让聊天叙述层与任务语义挂钩

### 6.6 `tool_calls`

```sql
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  tool_name TEXT NOT NULL CHECK (
    tool_name IN ('read_file', 'write_file', 'run_command')
  ),
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'pending_approval',
      'approved',
      'rejected',
      'running',
      'completed',
      'failed'
    )
  ),
  requires_approval INTEGER NOT NULL DEFAULT 0 CHECK (requires_approval IN (0, 1)),
  result_json TEXT,
  error_text TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

用途：

- 记录工具请求、状态变化和最终结果
- 支撑 detail pane 的工具结果视图

说明：

- `requires_approval` 避免每次都靠 `tool_name` 反推
- `message_id` 指向发起该工具调用的 assistant message

### 6.7 `approvals`

```sql
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  tool_call_id TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('write_file', 'run_command')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  decision_scope TEXT NOT NULL DEFAULT 'once' CHECK (
    decision_scope IN ('once', 'session_rule')
  ),
  payload_json TEXT NOT NULL,
  suggested_rule_json TEXT,
  decided_by TEXT,
  decision_reason_text TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
```

用途：

- 记录待审批请求和审批决定
- 为未来的“本 session 内记住这条规则”保留扩展位

说明：

- MVP UI 仍可只暴露 approve / reject
- `suggested_rule_json` 对应 OpenCode 一类产品里的 safe prefix / path pattern 概念

### 6.8 `artifacts`

```sql
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  tool_call_id TEXT REFERENCES tool_calls(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'diff',
      'stdout',
      'stderr',
      'error',
      'file_snapshot',
      'plan_summary',
      'task_summary',
      'final_result'
    )
  ),
  title TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'text/plain',
  body_text TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  CHECK (body_text IS NOT NULL OR payload_json IS NOT NULL)
);
```

用途：

- Detail Pane 稳定数据源
- 存储 diff、stdout、stderr、错误详情和阶段性摘要

说明：

- 大段文本放 `body_text`
- 结构化信息放 `payload_json`
- 不建议把所有输出都硬塞进 `tool_calls.result_json`

### 6.9 `session_events`

```sql
CREATE TABLE session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  sequence_no INTEGER NOT NULL,
  type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info' CHECK (
    level IN ('debug', 'info', 'warning', 'error')
  ),
  entity_type TEXT,
  entity_id TEXT,
  headline TEXT,
  detail_text TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (session_id, sequence_no)
);
```

用途：

- Execution Timeline 主数据源
- SSE replay / reconnect 基础
- resume 时恢复“做到哪一步了”

说明：

- `sequence_no` 是 session 内单调递增序号
- `entity_type + entity_id` 允许事件引用 `message / tool_call / approval / artifact / task / plan`
- Timeline 的“关键步骤”可以由 `type + level + payload_json` 派生，不需要单独做很多 event 子表

## 7. 推荐索引

```sql
CREATE INDEX idx_workspaces_last_opened_at
ON workspaces(last_opened_at DESC);

CREATE INDEX idx_sessions_workspace_updated_at
ON sessions(workspace_id, updated_at DESC);

CREATE INDEX idx_sessions_status
ON sessions(status);

CREATE INDEX idx_plans_session_version
ON plans(session_id, version DESC);

CREATE INDEX idx_tasks_session_position
ON tasks(session_id, position);

CREATE INDEX idx_tasks_session_status
ON tasks(session_id, status);

CREATE INDEX idx_messages_session_created_at
ON messages(session_id, created_at);

CREATE INDEX idx_messages_task_created_at
ON messages(task_id, created_at);

CREATE INDEX idx_tool_calls_session_created_at
ON tool_calls(session_id, created_at);

CREATE INDEX idx_tool_calls_task_status
ON tool_calls(task_id, status);

CREATE INDEX idx_approvals_session_status_created_at
ON approvals(session_id, status, created_at);

CREATE INDEX idx_approvals_tool_call_id
ON approvals(tool_call_id);

CREATE INDEX idx_artifacts_task_created_at
ON artifacts(task_id, created_at);

CREATE INDEX idx_session_events_session_sequence
ON session_events(session_id, sequence_no);

CREATE INDEX idx_session_events_task_sequence
ON session_events(task_id, sequence_no);
```

## 8. 为什么不是别的方案

### 8.1 为什么不只保留 `messages`

不够。

原因：

- plan/task 无法稳定查询
- approval 和 tool state 很难从 message 中可靠反推
- timeline 会变成前端拼装逻辑
- resume 时很难确定“停在第几个任务、哪次审批、哪条命令”

### 8.2 为什么不把 timeline 直接等同于 `messages + tool_calls + approvals`

也不够。

原因：

- task status change、session status change、plan confirmed、resume checkpoint 不是消息
- 一个 timeline 节点往往对应多个对象变化
- SSE 重连需要严格顺序，当前态表本身不提供 append-only 序列

### 8.3 为什么 `artifacts` 单独拆表

因为 detail pane 查的是“证据”，不是“对象状态”。

例子：

- `tool_calls` 里可以记录命令执行成功
- 但 stdout / stderr / diff patch / error stack 是需要单独展示和复用的产物
- 后续做 review/export/share 时，artifact 会比 tool result 更稳定

## 9. 建议的事件类型

`session_events.type` 首批建议覆盖：

- `session.created`
- `session.status_changed`
- `plan.created`
- `plan.confirmed`
- `task.created`
- `task.status_changed`
- `message.created`
- `tool.pending`
- `tool.running`
- `tool.completed`
- `tool.failed`
- `approval.created`
- `approval.resolved`
- `artifact.created`
- `session.checkpointed`
- `session.failed`
- `session.completed`

说明：

- `packages/shared/src/events.ts` 里当前的 SSE union 可以继续保留，但建议后续逐步与该枚举靠拢
- 数据库里的 `type` 不必和前端 event type 完全一一对应，但最好保持可映射

## 10. 第一批不落的表

为了控制 MVP 复杂度，以下能力先不进入首批 migration：

### 10.1 `task_attempts`

暂不落。

原因：

- retry 历史先交给 `session_events + artifacts`
- 先把主链路跑通，再看是否真的需要 attempt 级统计

### 10.2 `turn_usage` / `model_usage`

暂不落。

原因：

- 当前 MVP 不以成本统计为主目标
- 后续做 eval/dashboard 时再参考 OpenAI Agents 的 `turn_usage` 设计补上

### 10.3 `approval_rules`

暂不落。

原因：

- MVP 只有 approve / reject
- 但 `approvals.suggested_rule_json` 和 `decision_scope` 已预留升级位

### 10.4 FTS 虚表

暂不落。

原因：

- session search 是 P1
- 等真实搜索需求确定后，再决定是 `messages` 还是 `artifacts` 做 FTS5

## 11. SQLite 运行建议

建议在数据库初始化时开启：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
```

说明：

- `WAL` 适合本地读多写多且存在 SSE 读取的场景
- `foreign_keys = ON` 必开，否则约束形同虚设

## 12. 推荐落地顺序

第一步，先把 `apps/server/src/db/schema.ts` 从当前最小 schema 扩成下列首批表：

1. `workspaces`
2. `sessions`
3. `plans`
4. `tasks`
5. `messages`
6. `tool_calls`
7. `approvals`
8. `artifacts`
9. `session_events`

第二步，补对应的 shared DTO：

1. `PlanDto`
2. `TaskDto`
3. `ArtifactDto`
4. `SessionEventRecordDto` 或明确复用现有 `SessionEvent`

第三步，后端 service 从“内存 Map”切到“SQLite + repository”：

1. session service
2. plan/task service
3. approval service
4. event append service

第四步，再接 SSE：

1. 先从 `session_events` 回放历史
2. 再推送增量事件
3. reconnect 时带最后一个 `sequence_no`

## 13. 需要你确认的点

开始实现前，建议先确认以下取舍：

1. MVP 是否接受“一个 session 就是一条 run”，不单独引入 `session_runs`
2. `approval` 是否只做 `approve / reject`，还是要同步支持“本 session 内始终允许同类命令”
3. `artifact` 是否接受“文本内容直接存 SQLite”，还是你更想把大输出落文件、数据库只存索引
4. `task retry` 是否先不建 `task_attempts`

我的建议是：

1. 先不建 `session_runs`
2. 审批先做 `approve / reject`，但表里保留 `decision_scope`
3. 先把 artifact 文本直接存 SQLite
4. 先不建 `task_attempts`

## 14. 参考资料

- OpenAI Agents SDK, SQLiteSession: https://openai.github.io/openai-agents-python/ref/memory/sqlite_session/
- OpenAI Agents SDK, AdvancedSQLiteSession: https://openai.github.io/openai-agents-python/sessions/advanced_sqlite_session/
- OpenCode Permissions: https://opencode.ai/docs/permissions
- OpenCode Share: https://opencode.ai/docs/share
- OpenCode TUI: https://opencode.ai/docs/tui/
- Claude Code Settings: https://docs.anthropic.com/en/docs/claude-code/settings
- Claude Code Memory: https://docs.anthropic.com/en/docs/claude-code/memory
- goose Logging System: https://block.github.io/goose/docs/guides/logs/
- goose Session Management: https://block.github.io/goose/docs/guides/sessions/session-management/
- OpenHands WebSocket Connection: https://docs.all-hands.dev/openhands/usage/developers/websocket-connection
- OpenHands CLI Mode: https://docs.all-hands.dev/openhands/usage/how-to/cli-mode
