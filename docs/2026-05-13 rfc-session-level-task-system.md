# RFC: Session 级 Task 系统落地

Status: Proposed

Owner: OpenCode

Last Updated: 2026-05-13

Audience: 人类维护者、coding agent

## 1. 背景

当前项目在产品层和数据库层都已经为 task 留下了明显痕迹，但真实能力尚未接通。

已存在的基础包括：

1. `packages/orm/src/schema.ts`
   - 已有 `plans` 表
   - 已有 `tasks` 表
   - `sessions.currentPlanId/currentTaskId` 已存在
   - `messages/tool_calls/approvals/session_events/artifacts` 都可关联 `taskId`
2. `packages/shared/src/dto.ts`
   - `SessionCheckpoint` 已有 `planId/taskId`
   - `SessionDto` 已有 `currentPlanId/currentTaskId`
3. `apps/web/src/features/tasks/task-board.tsx`
   - 已有 TaskBoard 原型 UI
   - 已有 planning / executing 两套不同视觉草图
4. 历史文档 `docs/opencode-web-lite-mvp.md`
   - 已明确把 `plan`、`task`、`approval`、`artifact`、`event` 作为主视图对象

但当前真正缺失的是：

1. `PlanDto` / `TaskDto` 共享 contract
2. plan/task repository 和 service
3. task 相关读取接口
4. agent 对 task 的真实读写能力
5. TaskBoard 与真实 task 数据的接通

当前用户对首版的偏好已经明确：

1. task 不应由用户直接编辑
2. task 应完全交由 agent 管理
3. 前端首版只负责展示 board
4. 首版直接引入一组 task 工具，而不是只做 replace-all
5. 一旦 session 进入 `build`，就不允许再增加或减少 task，只允许更新状态和执行摘要

本 RFC 以这组约束为前提，重构 session 级 task 系统的落地方案。

## 2. 设计输入

### 2.1 当前项目已有 schema 与产品意图

关键现状：

1. `packages/orm/src/schema.ts:158-240`
   已定义 `tasks` 表，包括：
   - `sessionId`
   - `planId`
   - `position`
   - `title`
   - `description`
   - `acceptanceCriteriaJson`
   - `status`
   - `summaryText`
   - `lastErrorText`
   - `startedAt`
   - `completedAt`
2. `packages/orm/src/schema.ts:90-156`
   已定义 `plans` 表，包括：
   - `summaryText`
   - 以及若干为未来版本化工作流预留的字段
3. `packages/orm/src/schema.ts:644-717`
   `sessions` 已有：
   - `currentPlanId`
   - `currentTaskId`
4. 多个 durable truth 表都可以关联 `taskId`，例如：
   - `messages`
   - `tool_calls`
   - `approvals`
   - `session_events`
   - `artifacts`

这说明 task 首版不是从零设计，而是要把已有 schema 和 UI 逐步接到真实 runtime。

### 2.2 从 `../opencode` 借鉴的点

`../opencode` 里最相关的不是 team，而是“agent 在 session 内维护结构化工作清单”的产品哲学。

最值得借鉴的点：

1. task/todo 首版完全可以不依赖 team。
2. 它首先是一个 session 内的结构化工作清单。
3. 由 agent 主动创建、读取、更新、完成。

但本 RFC 不直接照搬 `todowrite` 的 replace-all 语义，而是采用更稳定的 task 实体模型。

### 2.3 与 plan/build mode 的关系

本 RFC 建立在“已有 `plan/build` 双模式”的前提上。task 的最合理职责分工是：

1. `plan` 负责建立任务拆分和任务内容
2. `build` 负责消费既有任务列表并推进任务状态

本 RFC 额外明确一个硬约束：

1. 在 `plan` 阶段允许增删 task
2. 一旦进入 `build`，task 集合冻结
3. `build` 只能更新既有 task 的状态、摘要、错误和执行时间

## 3. 目标

本 RFC 的目标如下：

1. 落地 session 级 `PlanDto` / `TaskDto` 与相关读取接口。
2. 让 task 系统在无 team 的普通单 agent 场景下也能完整可用。
3. 让 task 完全由 agent 管理，而不是让用户直接修改 task。
4. 让前端首版只展示真实 TaskBoard，不承担 task 编辑职责。
5. 首版直接提供 `TaskCreate` / `TaskList` / `TaskGet` / `TaskUpdate` / `TaskStop` 五个工具。
6. 让 `plan` 阶段能够创建任务列表，让 `build` 阶段只能推进任务状态。

## 4. 非目标

本 RFC 首版明确不做以下内容：

1. 不实现多 teammate owner 分配。
2. 不实现 team mailbox 或 SendMessage。
3. 不实现自动调度多个任务并发执行。
4. 不实现用户直接在前端创建、编辑、删除或停止 task。
5. 不实现完整的多版本 plan UI。
6. 不在首版做复杂依赖图编辑 UI。
7. 不在首版做 plan artifact/file。

## 5. 核心判断

### 5.1 task 首版不应依赖 team

普通用户没有 team，但仍然需要：

1. 把计划拆成可跟踪步骤
2. 知道当前执行到哪一步
3. 让 approval、artifact、message 与具体任务关联

因此 task 首版必须是 session 内部一等对象，而不是只有 team 开启后才存在的协作功能。

### 5.2 task 应属于整个 session，不是只属于 `plan`

task 的创建发生在 `plan`，但消费发生在 `build`。因此它不能做成“planning-only 临时数据”。

推荐语义：

1. `plan` 生成任务列表
2. `build` 逐条执行并更新
3. 用户在整个 session 生命周期中都能看到同一份 task list

### 5.3 task 应完全由 agent 改动，用户只读查看

本 RFC 首版不把 task 当作用户手工编辑的数据。

推荐语义：

1. 用户通过普通对话给出目标、约束、纠偏意见
2. agent 决定如何拆 task、如何推进 task、如何停止 task
3. 前端负责把当前 task board、当前任务和状态变化展示出来

这样更符合当前项目的产品形态：

1. 用户主要是在和 agent 协作，而不是自己维护工单系统
2. task 的主价值是让执行过程结构化，而不是提供复杂人工编辑界面
3. 可以避免前端首版陷入大量 task CRUD 交互细节

### 5.4 首版采用 single current plan，并收缩 plan 语义

虽然当前 `plans` 表还有一些为未来版本化工作流预留的字段，但本 RFC 首版不把它们暴露成共享 contract，也不把它们扩展成产品主语义。

首版明确采用：

1. 一个 session 只有一个 current plan
2. 首版所有 task 工具默认只操作 `session.currentPlanId`
3. `PlanDto` 首版只承担“当前 task board 容器”的职责
4. 不在首版做 plan version 切换 UI

也就是说：

1. 首版不把 plan 当作复杂状态机对象
2. 首版以“current plan + current tasks”为中心
3. 后续如果需要完整 versioning，再单独扩展 plan 语义

### 5.5 一旦进入 `build`，task 集合必须冻结

本 RFC 采用一个明确的产品约束：

1. `plan` 阶段允许创建 task
2. `plan` 阶段允许补充 task 内容
3. 一旦 session 开始 `build`，就不允许增加或减少 task
4. `build` 不能修改 task 的结构字段
5. `build` 只能推进既有 task 的状态和执行信息

原因：

1. 这能让 `build` 真的建立在“已形成计划”的前提上
2. 避免执行中 task 集合不断漂移，破坏 board 稳定性
3. 工具层更容易限制和审计
4. 更符合用户对 `plan -> build` 切换的心智

### 5.6 首版直接采用工具化 task 管理，而不是 replace-all

本 RFC 首版采用以下工具：

1. `TaskCreate`
2. `TaskList`
3. `TaskGet`
4. `TaskUpdate`
5. `TaskStop`

不采用 replace-all 的主要原因：

1. replace-all 容易诱导实现走向“删旧 task 再建新 task”
2. 当前 schema 中很多 durable truth 会关联 `taskId`
3. task 应该保持稳定 identity，而不是频繁重建

### 5.7 `TaskStop` 不是删除 task，而是停止推进该任务

首版建议把 `TaskStop` 明确映射为：

1. 将当前 task 从 `running` 或 `waiting_approval` 置为 `blocked`
2. 写入 `lastErrorText` 或等价原因文本
3. 可选更新 `summaryText`

首版不把 `TaskStop` 做成：

1. 删除 task
2. 从列表中移除 task
3. 新增 `stopped` 状态

这样可以复用当前已有 schema 状态集合，减少扩展面。

## 6. 总体方案

### 6.1 共享 DTO

建议在 `packages/shared/src/dto.ts` 新增：

```ts
export type PlanDto = {
  id: string;
  sessionId: string;
  summaryText?: string;
  createdAt: string;
};

export type TaskDto = {
  id: string;
  sessionId: string;
  planId: string;
  position: number;
  title: string;
  description?: string;
  acceptanceCriteria: string[];
  status:
    | 'todo'
    | 'ready'
    | 'running'
    | 'blocked'
    | 'waiting_approval'
    | 'done'
    | 'failed';
  summaryText?: string;
  lastErrorText?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};
```

并在 `SessionDto` 之外增加一个专门给前端 board 使用的读取结构，例如：

```ts
type SessionPlanBoardDto = {
  session: SessionDto;
  currentPlan?: PlanDto;
  currentTask?: TaskDto;
  tasks: TaskDto[];
  waitingApprovalTaskIds: string[];
};
```

这里不要求把所有 UI 占位字段都进 shared。首版只返回真正 durable 的 task/plan/session 数据，以及少量必要聚合结果。

### 6.2 Server 侧 repository 与 service

建议新增：

1. `plan-repository.ts`
2. `task-repository.ts`
3. `services/session/plan-service.ts`
4. `services/session/task-service.ts`

其中首版至少提供：

1. 获取或创建 session 的 current plan
2. 列出 current plan 下的 task 列表
3. 创建 task
4. 查询单个 task
5. 更新 task
6. 停止 task
7. 维护 `session.currentPlanId/currentTaskId`

### 6.3 API 设计

首版 API 以读取为主，不把 task 修改能力设计成用户产品主路径。

建议：

1. `GET /api/sessions/:sessionId/plan-board`
   - 返回 `SessionPlanBoardDto`

如果后端内部需要 HTTP 面暴露给 runtime 或测试，可额外保留内部接口，但不作为首版前端交互主路径写入 RFC 核心流程。

也就是说，本 RFC 首版的用户路径是：

1. 用户发普通消息
2. agent 调 task tools
3. 前端轮询/查询/SSE 后刷新 board

而不是：

1. 用户点按钮直接 patch task

### 6.4 Tool 设计

首版直接提供以下模型可见工具：

1. `TaskCreate`
2. `TaskList`
3. `TaskGet`
4. `TaskUpdate`
5. `TaskStop`

建议语义如下。

#### `TaskCreate`

用途：

1. 在 `currentPlanId` 下创建一个新 task

建议字段：

1. `title`
2. `description?`
3. `acceptanceCriteria?: string[]`
4. `position?`
5. `status?`，仅允许首版初始化到 `todo` 或 `ready`

限制：

1. 只允许在 `plan` mode 使用
2. 一旦 session 已进入 `build`，硬禁止调用

#### `TaskList`

用途：

1. 列出 `currentPlanId` 下所有 task
2. 供 agent 在 planning/build 中读取当前 board 结构

限制：

1. `plan` / `build` 都允许

#### `TaskGet`

用途：

1. 读取单个 task 的详细信息

限制：

1. `plan` / `build` 都允许

#### `TaskUpdate`

用途：

1. 更新单个 task 的状态、摘要、错误或内容字段

限制：

1. `plan` mode
   - 允许修改：`title`、`description`、`acceptanceCriteria`、`position`
   - 允许设置初始状态：`todo`、`ready`
2. `build` mode
   - 禁止修改 task 集合结构
   - 禁止修改 `title`、`description`、`acceptanceCriteria`、`position`
   - 只允许修改：`status`、`summaryText`、`lastErrorText`、`startedAt`、`completedAt`

#### `TaskStop`

用途：

1. 明确停止推进某个任务

限制与结果：

1. 主要在 `build` mode 使用
2. 将任务置为 `blocked`
3. 记录停止原因
4. 不删除 task，不移出列表

### 6.4.1 参考 `../claude-code` 的工具提示词适配

参考文件：

1. `../claude-code/src/tools/TaskCreateTool/prompt.ts`
2. `../claude-code/src/tools/TaskListTool/prompt.ts`
3. `../claude-code/src/tools/TaskGetTool/prompt.ts`
4. `../claude-code/src/tools/TaskUpdateTool/prompt.ts`
5. `../claude-code/src/tools/TaskStopTool/prompt.ts`

适配结论：

1. `TaskCreate` / `TaskList` / `TaskGet` / `TaskUpdate` 的提示词结构可以大量借鉴
2. 但必须删除 `owner`、`blockedBy`、`deleted`、teammate 等 swarm 相关语义
3. `TaskStop` 不能直接照搬，因为 `../claude-code` 原义是“停止后台任务”，而本项目里它应表示“停止推进某个 session task 并置为 blocked”

建议首版在本项目中使用以下 description 与 prompt 文案。

#### `TaskCreate` 建议提示词

```ts
description: 'Create a new task in the current session plan'

prompt: `Use this tool to create a structured task in the current session's task board.

## When to Use This Tool

- Use it proactively during plan mode when the work should be broken into multiple meaningful steps.
- Use it when the user request is complex enough that tracking progress on the board will help execution.
- Use it when a missing task needs to be added before implementation begins.

## When NOT to Use This Tool

- Do not use it for a single trivial task.
- Do not use it after the session has entered build. Task creation is frozen once implementation begins.

## Tips

- Check TaskList first to avoid duplicate tasks.
- Create tasks with clear titles, concise descriptions, and concrete acceptance criteria.
- Default new tasks to \\`todo\\`. Use \\`ready\\` only when the task is immediately executable.
- Create stable tasks that can survive the full session, not throwaway scratch notes.`
```

#### `TaskList` 建议提示词

```ts
description: 'List all tasks in the current session plan';

prompt: `Use this tool to list all tasks in the current session plan.

## When to Use This Tool

- Use it before creating new tasks, so you understand the current board and avoid duplicates.
- Use it to check overall progress and identify the current task.
- Use it after completing, blocking, or pausing a task to decide what remains.
- In build mode, prefer checking the task list before starting the next task.

## Output

Returns a summary of each task, including:
- id
- title
- status
- summaryText
- lastErrorText

Use TaskGet with a specific task ID when you need the full description and acceptance criteria.`;
```

#### `TaskGet` 建议提示词

```ts
description: 'Get a task by ID from the current session plan';

prompt: `Use this tool to retrieve a task by its ID from the current session plan.

## When to Use This Tool

- Use it when you need the full description and acceptance criteria before starting work.
- Use it before TaskUpdate or TaskStop if you may be acting on stale information.
- Use it when you need to understand the latest state of the current task in detail.

## Output

Returns full task details, including:
- title
- description
- acceptanceCriteria
- status
- summaryText
- lastErrorText

Use TaskList to see the full board in summary form.`;
```

#### `TaskUpdate` 建议提示词

```ts
description: 'Update a task in the current session plan'

prompt: `Use this tool to update a task in the current session plan.

## When to Use This Tool

- Use it to refine task content during plan mode.
- Use it to move a task through its execution states during build.
- Use it to record execution summaries, blockers, and errors.

## Rules

- In plan mode, you may refine structure fields such as title, description, acceptanceCriteria, and position.
- In build mode, you may only update execution fields: status, summaryText, lastErrorText, startedAt, completedAt.
- Never use TaskUpdate in build mode to change task structure or to indirectly grow or shrink the task set.
- Only mark a task \\`done\\` when the work is fully accomplished and validated.
- If a task is paused on approval or blocked by missing prerequisites, update that state clearly instead of pretending it is complete.

## Staleness

- Read the latest task state with TaskGet before updating if the task may have changed since you last inspected it.`
```

#### `TaskStop` 建议提示词

```ts
description: 'Stop a task by marking it blocked in the current session plan'

prompt: `Use this tool when a task that is currently running or waiting for approval must be intentionally stopped.

## What This Tool Does

- Marks the task as \\`blocked\\`
- Records the reason execution cannot continue
- Keeps the task on the board for later recovery or replanning

## When to Use This Tool

- Use it when an external dependency is missing.
- Use it when an assumption was invalidated and the task cannot safely continue.
- Use it when the user explicitly asks to stop work on the current task.
- Use it when continuing would be misleading or unsafe.

## When NOT to Use This Tool

- Do not use it to delete tasks.
- Do not use it as a substitute for marking a task \\`done\\`.
- Do not use it for tasks that never actually started; prefer TaskUpdate instead.

This tool is not a background process killer. It is a structured task-state transition for the session task board.`
```

### 6.5 Runtime 与 task 的关系

首版建议把 task 对 runtime 的接入控制在一个最小闭环：

1. `plan` agent 使用 `TaskCreate/TaskUpdate` 生成当前任务列表
2. server 维护 `session.currentPlanId`
3. `build` agent 执行时，server 或 runtime 可维护 `session.currentTaskId`
4. `build` agent 使用 `TaskUpdate/TaskStop` 推进任务状态
5. tool call、approval、message、event 继续沿用已有 `taskId` 关联字段

首版不要求 run loop 自动从 `ready` 任务调度下一项，但应为这一步保留结构。

### 6.6 TaskBoard 接通真实数据

当前 `apps/web/src/features/tasks/task-board.tsx` 已有足够清楚的目标 UI，但首版应收缩为只读 board。

首版建议：

1. 用 `GET /api/sessions/:sessionId/plan-board` 的真实数据替换 mock `session.tasks`
2. 保留 planning/executing 的视觉分层
3. 去掉或禁用直接修改 task 的按钮语义
4. 首版只展示：
   - 当前 goal
   - current plan summary
   - task list
   - current task
   - 每个 task 的状态
   - 与 task 相关的待审批聚合信息

换句话说，TaskBoard 首版是：

1. 一个结构化执行看板
2. 不是一个用户手工编辑的任务管理器

## 7. 建议状态机

首版 task 状态推进建议如下：

```text
todo
  -> ready
  -> running
  -> waiting_approval
  -> running
  -> done

running
  -> blocked
  -> failed

waiting_approval
  -> blocked
```

建议语义：

1. `todo`
   - 计划里已列出，但尚未可执行
2. `ready`
   - 依赖已满足，可开始执行
3. `running`
   - 当前正在执行
4. `waiting_approval`
   - 当前任务因高风险工具停在审批点
5. `blocked`
   - 缺少前置条件、外部决策，或被 `TaskStop` 主动停止
6. `done`
   - 已完成
7. `failed`
   - 该任务本轮失败，需要 retry 或 replan

## 8. 实施拆分

### 8.1 第 1 批：真实数据与只读 Board

包含：

1. `PlanDto/TaskDto`
2. plan/task repository 和 service
3. `GET /plan-board`
4. Web TaskBoard 接通真实数据

### 8.2 第 2 批：task tools 与 runtime 写入

包含：

1. `TaskCreate`
2. `TaskList`
3. `TaskGet`
4. `TaskUpdate`
5. `TaskStop`
6. `currentPlanId/currentTaskId` 与 session 联动

### 8.3 第 3 批：更强工作流

后续可选：

1. 自动从 `ready` 中选择下一任务
2. task retry
3. blocked resolution
4. 更完整的 plan versioning 工作流

## 9. 与双模式 RFC 的关系

本 RFC 依赖 `plan/build` 双模式基础能力先落地。

推荐时序：

1. 先完成双模式 RFC
2. 再落 task RFC

原因：

1. task 创建主要发生在 `plan`
2. task 执行主要发生在 `build`
3. “进入 build 后冻结 task 集合”的规则建立在双模式之上

## 10. 验证建议

至少补以下测试：

1. `TaskDto/PlanDto` 映射测试
2. `GET /plan-board` 返回当前 session 的 plan + tasks + currentTask
3. `TaskCreate` 只允许在 `plan` mode 创建 task
4. session 一旦进入 `build`，`TaskCreate` 与 task 删除类操作被工具层拒绝
5. `TaskUpdate` 在 `build` mode 只能更新状态/摘要/错误，不得修改结构字段
6. `TaskStop` 将任务置为 `blocked` 并记录原因
7. 更新 task 状态后 `currentTaskId` 和相关 session event 正确
8. TaskBoard 真实数据渲染正确
