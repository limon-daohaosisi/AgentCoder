# RFC: Plan File 与 plan_exit 工作流落地

Status: Proposed

Owner: OpenCode

Last Updated: 2026-05-14

Audience: 人类维护者、coding agent

## 1. 背景

当前项目已经落地了 `plan/build` 双模式基础能力，以及 session 级 task board 与 task tools。

今天的真实能力更接近：

1. `plan` 模式下可读工作区并可直接创建/更新 task。
2. `build` 模式下可执行代码修改和推进 task 状态。
3. session 会自动拥有一个 `currentPlan`，但这个 `plan` 目前更像 task 容器，而不是一篇真实的计划文档。

这与 `../opencode`、`../claude-code` 的 planning 心智仍有一个关键差距：

1. 它们都有独立的 plan artifact/file。
2. `plan` 模式下真正的可写对象是 plan file，而不是工作区代码。
3. `plan -> build` 通过显式的 exit tool + approval 完成。
4. task/todo 可以在 planning 过程中创建，但 planning 的主事实源仍是一篇完整 plan。

当前项目虽然有 `plans.summaryText` 和 `plans` 表，但还没有做到：

1. 让 agent 在 `plan` 模式下先形成并持久化一篇完整 plan。
2. 让 `plan` 模式的唯一文件写权限落在 plan file 上。
3. 让 `plan_exit` 成为正式的审批驱动切换工作流。
4. 让 task 明确成为“基于 plan 产生的执行清单”，而不是和 plan 并列、甚至替代 plan 的主语义。

本 RFC 的目标是把这条链路补齐，但保持与当前项目已落地的 `variant`、task board、approval/resume 主链路兼容。

## 2. 设计输入

### 2.1 当前项目已有基础

当前仓库已经具备以下与本 RFC 直接相关的基础：

1. `packages/agent/src/context/system-context.ts`
   - 已根据 `runtime.variant` 注入 `plan/build` overlay。
2. `packages/agent/src/context/tool-registry.ts`
   - 已按 `variant` 过滤工具。
   - `plan` 当前允许：`read/glob/grep/task_*`
3. `apps/server/src/services/session/plan-service.ts`
   - 已能创建并维护 `session.currentPlanId`。
4. `apps/server/src/repositories/plan-repository.ts`
   - 已能读取和创建 `PlanDto`。
5. `packages/orm/src/schema.ts`
   - 已有 `plans.summary_text`。
6. `apps/web/src/features/tasks/task-board.tsx`
   - 已会展示 `currentPlan.summaryText`，只是现在大多为空。
7. approval/resume 主链路已完备：
   - `SessionInteractionService`
   - `Lifecycle`
   - `RunLoop`
   - `SessionProcessor`
   - `ToolExecutor`

因此，本 RFC 不需要从零引入“plan”概念，而是要把已有 `plans` 从容器提升为真实 planning artifact。

### 2.2 从 `../opencode` 借鉴的点

本项目最值得借鉴的点如下：

1. plan 有独立 file path，而不是只停留在 assistant 文本里。
2. `plan` 模式下普通代码编辑被禁用，但允许编辑 plan file。
3. `plan_exit` 是正式工具，而不是纯前端手动切换。
4. 退出 planning 通过 approval 切换到 build。
5. build 运行时会被明确提醒：已有 plan file，应按 plan 执行。

### 2.3 从 `../claude-code` 借鉴的点

本项目最值得借鉴的点如下：

1. plan mode prompt 很明确地要求：
   - explore
   - design
   - review
   - write final plan
   - then exit plan mode
2. plan file 是 planning 的 durable source of truth。
3. `ExitPlanMode` 不依赖模型口头摘要，而是读取 plan artifact。
4. task 可以在 plan mode 中创建，但它不是 plan 的替代品。

本 RFC 明确采纳这种策略：

1. planning workflow 主要由 prompt 驱动。
2. runtime 负责权限和 mode handoff。
3. task 允许在 plan mode 中创建。
4. 但 plan file 必须成为更高一级的事实源。

## 3. 目标

本 RFC 的目标如下：

1. 为每个 session 的 current plan 引入真实 plan file。
2. 让 `plan` 模式下唯一允许写入的文件类目标变成 plan file。
3. 让前端能够读取并展示完整的 plan file，而不是只看摘要。
4. 落地正式的 `plan_exit` 工具，并接入 approval/resume 主链路。
5. 保留当前“plan 模式下可以先生成 task”的能力，但要求 task 服从 plan，而不是替代 plan。
6. 让前端在 TaskBoard 中能展示真实 plan 摘要，并为后续 plan file 预览留出口。

## 4. 非目标

本 RFC 首版明确不做以下内容：

1. 不实现 plan markdown 到 task 的自动编译器。
2. 不实现完整多版本 plan UI。
3. 不在首版做 workspace 内可见的复杂 plan 文件树浏览器。
4. 不引入 `../claude-code` 的完整 permission state machine。
5. 不重做 `variant` 为 agentName-based 模型；仍以 `runtime.variant` 为事实源。

## 5. 核心判断

### 5.1 plan file 应成为 planning 的 durable source of truth

当前 `plans` 表已有 `summaryText`，但这不足以替代完整 planning artifact。

原因：

1. `summaryText` 更适合做次级元数据，而不是承载完整 plan markdown。
2. planning 往往需要多段结构：背景、约束、方案、风险、执行步骤。
3. 与 `../opencode` / `../claude-code` 对齐时，独立 plan file 更利于 mode 切换和恢复。

因此，本 RFC 采用：

1. 完整 plan 文本保存在 plan file。
2. 前端和审批 UI 的主展示对象应是完整 plan file，而不是 `summaryText`。
3. `plans` 仍然是 session-level current plan 的 durable anchor。

### 5.2 `plan` 模式应是“工作区只读，但允许写 planning artifact”

本 RFC 明确重新定义 `plan` 模式：

1. 对工作区代码和普通文件：只读。
2. 对 shell：禁用。
3. 对 plan file：允许写。
4. 对 planning metadata：允许写。
   - 例如 `task_create/task_update`
   - 例如 `plan_exit`

这比“全局无副作用只读”更符合产品目标，也与参考实现一致。

### 5.3 task 可以在 plan mode 中创建，但不应绕过 plan

本 RFC 不采用“先 final plan，后才能创建 task”的硬性 runtime 限制。

原因：

1. `../claude-code` 本身也允许在 plan mode 中创建 task。
2. 复杂 planning 常常需要一边写 plan，一边把结构化 task 记下来。
3. 当前项目已落地 task board，完全禁掉会带来不必要回退。

但本 RFC 额外要求 prompt 明确强调：

1. 先形成一版完整 plan。
2. 再基于该 plan 创建/调整 task。
3. 如果 plan 被推翻，应先更新 plan file，再调整 task。

也就是说，task 允许早出现，但语义上从属于 plan。

### 5.4 `plan_exit` 应成为 planning 的正式边界

当前项目虽然前端可手动切到 build，但这不应是长期主路径。

本 RFC 采用：

1. `plan_exit` 仅在 `plan` 模式可见。
2. 它默认要求 approval。
3. 它读取当前 plan artifact 与摘要，作为退出 planning 的 payload 基础。
4. 批准后，服务端写入 synthetic user message：
   - `runtime.variant = 'build'`
   - 内容明确说明计划已批准并开始执行
5. runtime 继续下一轮 build。

### 5.5 首版不需要独立 plan parser，只需要 plan file + prompt + handoff

本 RFC 首版不做：

1. 从 plan markdown 自动生成 task
2. 从 task 自动反推 plan

首版只做：

1. durable plan file
2. plan-only writable target
3. prompt 中明确 planning workflow
4. `plan_exit` approval handoff

这已经足够复用参考项目最关键的产品心智。

## 6. 总体方案

### 6.1 数据模型

首版建议保持 `plans` 表为 session-level plan anchor，并新增/扩展以下内容：

1. `PlanDto` 增加：

```ts
type PlanDto = {
  id: string;
  sessionId: string;
  filePath?: string;
  createdAt: string;
};
```

2. 完整 plan markdown 不直接塞入 `PlanDto`。
3. 通过新的 plan file 读取接口按需获取。

现有 `plans.summaryText` 字段可以保留在数据库里，但本 RFC 首版不再把它作为主展示或主工作流依赖。

首版 file path 建议采取稳定规则，例如：

```text
.mycoding/plans/<session-id>-plan.md
```

或：

```text
.mycoding/plans/<current-plan-id>.md
```

推荐使用 `currentPlanId`，避免 session 标题变化带来路径漂移。

同时明确：

1. plan file 属于当前 session 的 workspace。
2. 它应位于 workspace root 下，而不是全局 data dir。
3. 首版推荐最终路径规则为：

```text
<workspace-root>/.mycoding/plans/<current-plan-id>.md
```

### 6.2 plan file 解析与持久化

建议新增 `plan-file-service.ts`，职责如下：

1. 解析 current plan file path
2. 获取 plan file 相对路径
3. 读取 plan file 内容
4. 首次创建 current plan 时初始化空 plan file
5. 返回完整 plan file 内容供 API 和 approval 使用

首版不要求复杂 frontmatter，可采用纯 markdown 模板，例如：

```md
# Plan

## Goal

## Constraints

## Approach

## Risks

## Execution Outline
```

### 6.3 plan file 读取接口

前端首版不再以 `summaryText` 为主展示，而应直接展示完整 plan file。

建议新增接口：

```text
GET /api/sessions/:sessionId/plan-file
```

返回结构建议为：

```ts
type SessionPlanFileDto = {
  plan: PlanDto;
  content: string;
  exists: boolean;
  filePath: string;
};
```

该接口职责：

1. 解析 current plan file path
2. 读取完整 plan file 内容
3. 供 TaskBoard / DetailPane / approval UI 使用

### 6.4 plan mode 下的工具权限

首版 `plan` 模式建议允许：

1. `read`
2. `glob`
3. `grep`
4. `task_create`
5. `task_list`
6. `task_get`
7. `task_update`
8. `task_stop`
9. `write`
10. `edit`
11. `plan_exit`

首版 `plan` 模式建议禁止：

1. `bash`
2. `apply_patch`

但增加一条例外机制：

1. `write/edit` 对普通路径仍禁用
2. 对当前 session 的 plan file path 允许
3. `apply_patch` 在 `plan` 模式下首版保持禁用，不作为 plan file 编辑主路径

换句话说：

1. 不是简单的工具名 allowlist
2. 而是 `plan` 模式下对 `write/edit` 增加 path-level policy

### 6.5 path-level policy 建议

建议在 tool execution/approval payload 层增加 `planWritablePaths` 概念。

推荐实现点：

1. `prepareToolExecution(...)`
2. `buildApproval(...)`
3. workspace path guard
4. `resolveTools()` 或更底层 execution policy

建议语义：

1. `plan` 模式：
   - 普通路径写入拒绝
   - `write` 仅允许在目标路径等于 current plan file path 且文件尚不存在时使用
   - `edit` 仅允许在目标路径等于 current plan file path 且文件已存在时使用
2. `build` 模式：
   - 恢复正常现有策略

为了更接近 `../opencode` / `../claude-code` 的体验，首版建议进一步采用：

1. 命中 current plan file path 的 `write/edit` 在 `plan` 模式下自动放行，不再走人工 approval。
2. 任何非 plan file 路径的 `write/edit` 在 `plan` 模式下直接拒绝。

这样可以避免：

1. planning 过程中频繁编辑 plan file 时被审批打断
2. `write/edit plan file` 与 `plan_exit` 在同一策略层面互相冲突

### 6.6 新工具：`plan_exit`

首版建议新增工具：

```text
plan_exit
```

用途：

1. 请求结束 planning
2. 请求用户批准当前 plan
3. 批准后切到 `build`

输入建议：

```ts
{
  summary?: string;
}
```

真正 payload 应由服务端构建，至少包含：

1. `planId`
2. `planFilePath`
3. `planContent`

approval kind 首版可复用现有 approval 框架中的新 kind，例如：

```ts
'plan_exit';
```

若不想在首版扩张 approval kind，也可用更通用 payload，但推荐直接建新 kind，语义更清晰。

### 6.7 `plan_exit` 批准后的恢复语义

批准后服务端建议执行：

1. 读取 current plan file
2. 创建一条 synthetic user message：

```ts
{
  role: 'user',
  content: 'The plan has been approved. Begin implementation according to the current plan file and task list.',
  runtime: {
    variant: 'build'
  }
}
```

3. 为该 synthetic message 标注 metadata：
   - `synthetic: true`
   - `planId`
   - `planFilePath`
4. `Lifecycle.startPromptRun(...)` 继续下一轮

### 6.8 prompt 设计

本 RFC 建议把 `plan` 模式 overlay 改成更接近 `../claude-code` 的五段式工作流。

建议核心语义：

1. 你当前处于 planning mode
2. 你不得修改工作区代码或运行 shell
3. 如果当前 plan file 不存在，你应使用 `write` 在指定路径创建它
4. 如果当前 plan file 已存在，你应使用 `edit` 增量更新它
5. 复杂请求下请先探索、设计、审视风险，再形成完整 plan
6. 形成 plan 后，可以创建或整理 task，用于后续执行跟踪
7. 当你认为 plan 已成熟，应调用 `plan_exit`

建议加入明确流程：

1. Explore
2. Design
3. Review
4. If the plan file does not exist, create it with `write`
5. If the plan file exists, keep refining it with `edit`
6. Create/refine task list
7. Exit plan mode

需要注意：

1. 不要把“先 final plan 再 task”写成硬规则
2. 应写成“task 应基于当前 plan，并在 plan 变化时保持一致”

### 6.9 TaskBoard 与前端展示

前端首版建议：

1. TaskBoard 或 DetailPane 直接展示完整 plan file 内容
2. 展示 plan file path
3. `GET /api/sessions/:sessionId/plan-file` 成为前端读取主路径
4. `plan_exit` approval UI 应显示：
   - plan file 路径
   - 完整 plan 内容或可滚动全文视图

首版不强制必须在 Web 直接编辑 plan file；agent 通过工具修改即可。

## 7. 对当前 RFC 的修正关系

本 RFC 会修改之前两份 RFC 的部分结论。

### 7.1 对双模式 RFC 的修正

修正点：

1. 原文把 plan file 作为非目标
2. 现在改为：plan file 是正式目标

修正后的 `plan` 语义应为：

1. 工作区只读
2. shell 禁用
3. 允许通过 `write/edit` 写 plan file
4. 允许写 planning metadata（task、plan summary、plan_exit）

### 7.2 对 task RFC 的补充

补充点：

1. task 允许在 `plan` 模式生成
2. 但 planning 的主事实源是 plan file
3. task 是 plan 的执行清单，不是 plan 的替代物

### 7.3 对 plan summary 主线的收缩

补充点：

1. 不新增 `plan_write_summary`
2. 不要求前端以 `summaryText` 为主要展示对象
3. plan 的主展示对象是完整 plan file

## 8. 实施拆分

### 8.1 第 1 批：plan file 基础能力

包含：

1. 规划 plan file path 规则
2. 增加 plan file service
3. 扩展 `PlanDto.filePath`
4. 新增 `GET /api/sessions/:sessionId/plan-file`
5. `planService.getSessionPlanBoard()` 返回 file path
6. prompt 中增加 plan file 心智

完成标准：

1. 每个 session current plan 都有稳定 plan file path
2. 前端能读取并展示完整 plan file

### 8.2 第 2 批：plan-only writable path policy

包含：

1. `plan` 模式下普通写工具对工作区保持禁用
2. `write` 仅用于首次创建 current plan file
3. `edit` 仅用于后续增量修改 current plan file
4. 对 current plan file path 开白
5. approval/buildApproval payload 识别该例外

完成标准：

1. `plan` 模式写普通代码文件失败
2. `plan` 模式首次创建 plan file 时 `write` 成功
3. `plan` 模式后续修改 plan file 时 `edit` 成功

### 8.3 第 3 批：planning prompt 与完整 plan 展示收口

包含：

1. `plan` prompt 明确：首次创建用 `write`，后续修改用 `edit`
2. `plan` prompt 要求“先形成完整 plan，再基于 plan 拆 task”
3. 前端展示完整 plan file

完成标准：

1. 前端能稳定展示完整 plan file
2. 模型在 `plan` 中会显著更稳定地产出 plan 文本

### 8.4 第 4 批：`plan_exit` 正式工作流

包含：

1. 新增 `plan_exit` 工具
2. 接入 approval
3. 批准后 synthetic user message 切到 build
4. build prompt 注入“已有 plan file，应按其执行”的提醒

完成标准：

1. 用户不必手动切 build 也能进入执行
2. 审批 UI 能看到要批准的完整计划文本

## 9. 关键代码落点建议

预计涉及：

1. `packages/shared/src/dto.ts`
   - `PlanDto.filePath`
   - 可能新增 `ToolName = 'plan_exit'`
2. `packages/agent/src/context/system-context.ts`
   - 计划工作流 overlay
3. `packages/agent/src/context/tool-registry.ts`
   - `plan` 工具表扩展
   - 可能需要从“简单 allowlist”升级到更细粒度 policy
4. `packages/agent/src/tools/*`
   - `plan_exit`
5. `packages/agent/src/tool-executor.ts`
   - plan_exit approval handoff
   - plan file write policy 协调
6. `apps/server/src/services/session/plan-service.ts`
   - plan file 路径装配
   - plan file 读取接口装配
7. `apps/server/src/routes/sessions/*`
   - `GET /api/sessions/:sessionId/plan-file`
8. `apps/server/src/services/agent/interaction-service.ts`
   - synthetic build message
9. `apps/server/src/services/agent/run-service.ts`
   - 新 approval kind 支持
10. `apps/web/src/features/tasks/task-board.tsx`

- 展示完整 plan file 与 file path

11. `apps/web/src/features/approvals/*`

- `plan_exit` payload 展示

## 10. 验证建议

至少补以下测试：

1. current plan file path 生成稳定且与 current plan 一致
2. `plan` 模式下普通文件写入被拒绝
3. `plan` 模式下首次创建 current plan file 会使用 `write`
4. `plan` 模式下后续修改 current plan file 会使用 `edit`
5. `plan_exit` 仅在 `plan` 模式可见
6. `plan_exit` 创建 approval payload 时会读取当前 plan file
7. 批准 `plan_exit` 后会写 synthetic user message，且 `runtime.variant = build`
8. build 下一轮 context 中包含“按当前 plan 执行”的提醒
9. `GET /api/sessions/:sessionId/plan-file` 返回完整 plan file 内容
10. plan mode 下 task 仍可创建，且前端已展示完整 plan file

## 11. 推荐执行顺序

推荐按以下顺序实施：

1. 先落 plan file + `PlanDto.filePath` + `GET /plan-file`
2. 再落 path-level write policy
3. 再落 planning prompt 中的 `write/edit` 明确指引
4. 再落 `plan_exit`
5. 最后考虑是否收紧前端手动切 build 的主路径

原因：

1. 没有 plan file 时，`plan_exit` 很容易退化成“批准一段口头文本”
2. 没有完整 plan 读取接口时，前端只能退回到摘要视图
3. 先有 durable plan artifact，后续 approval 和 build handoff 才有真正锚点

## 12. 结论

本项目如果要真正对齐 `../opencode` / `../claude-code` 的 planning 体验，不需要一开始就做 plan-to-task 自动编译。

更关键的是先建立：

1. 独立的 plan file
2. 该 file 位于 session workspace 下的 `.mycoding/plans/`
3. `plan` 模式下仅允许用 `write/edit` 修改该 file
4. 前端通过专门接口展示完整 plan file
5. 明确的 planning prompt
6. `plan_exit` approval handoff
7. task 作为基于 plan 的执行清单，而不是替代 plan 的主语义

这是当前项目最小且正确的对齐路线。
