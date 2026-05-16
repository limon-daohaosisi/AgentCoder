# plan/build 模式研究：opencode 与 claude-code 对比

研究对象：`../opencode`、`../claude-code`。

研究目标：搞清楚这两个项目里 plan/build 相关能力的真实实现，重点看模式建模、工具权限、提示词注入、UI 或命令入口、审批切换链路，以及这些做法对当前仓库的落地价值。

## 1. 结论摘要

最重要的结论先说：

| 主题          | `../opencode`                                                 | `../claude-code`                                                                                      | 对当前仓库的启发                                                                                                              |
| ------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 核心建模      | `plan/build` 是内建 primary agent                             | 没有单独的 `build` mode，只有 permission mode 里的 `plan`；实现阶段只是离开 `plan` 后回到其他权限模式 | 当前仓库更适合先把 `plan/build` 落在 `message.runtime.variant`，而不是先造完整 agent registry 或复杂 permission state machine |
| 约束方式      | agent permission + synthetic reminder + 可选 `plan_exit` 工具 | permission mode + Enter/ExitPlanMode tool + plan file + approval UI + `prePlanMode` 恢复              | 当前仓库不能只加 prompt overlay，必须让 `resolveTools()` 真正受 mode 影响                                                     |
| 切换入口      | `default_agent`、CLI/TUI agent picker、API `agent` 参数       | `/plan` 命令、Shift+Tab mode cycle、SDK `set_permission_mode`、Enter/ExitPlanMode tool                | 当前仓库首版最小入口可以是 API `variant` 参数 + Web UI 模式切换                                                               |
| 计划审批      | `plan_exit` 在实验模式下触发“切回 build”的确认                | `ExitPlanMode` 是正式工作流，读取 plan file，并在批准后恢复到实现模式                                 | 当前仓库已有完整 approval/resume 主链路，后续很适合新增一个虚拟工具式的 `exit_plan_mode`                                      |
| plan artifact | 有实验性 plan file 工作流                                     | 有正式 plan file，且是 plan mode 的中心工件                                                           | 当前仓库首版不必先上 plan file，可以先让计划以 assistant 文本产出，后续再补 durable artifact                                  |

我对当前仓库的总体判断：

1. 当前仓库已经有很好的切入点：`MessageRuntimeMetadata.variant` 已经可持久化，`packages/agent/src/context/system-context.ts` 已经有 `plan/build` 的 runtime overlay。
2. 当前仓库缺的不是 mode 文案，而是 mode 对工具暴露和切换流程的真实约束。
3. 因此最合适的路线不是照搬 `opencode` 的 agent 体系，也不是直接照搬 `claude-code` 的 permission mode 体系，而是先做一个以 `variant` 为事实源的轻量模式系统。

## 2. 当前仓库的相关现状

先标出当前仓库已经具备、但还没完全打通的基础：

1. `packages/agent/src/prompt.ts:3-37`
   `normalizePrompt()` 已经支持 `variant?: string`，并会把它写入 `message.runtime.variant`。
2. `packages/agent/src/context/system-context.ts:45-100`
   runtime 已经会根据 `lastUserRuntime.variant` 注入 `<system-reminder>`。
   - `plan` 时提示偏只读、偏规划。
   - `plan -> build` 切换时会注入 “Your operational mode has changed from plan to build.”。
3. `packages/agent/src/context/tool-registry.ts:12-28`
   当前 `resolveTools()` 完全不看 `variant`，只是把 last-user `toolOverrides` 与内建工具表做合并。
4. `packages/shared/src/contracts.ts:32-45`
   `CreateSessionInput` 和 `SubmitSessionMessageInput` 目前都不能传 `variant`。
5. `apps/server/src/services/agent/interaction-service.ts:63-147`
   server 提交消息时只把 `content` 传给 `normalizePrompt()`，还没有 mode 控制面。
6. `apps/web/src/lib/session-view.ts:341-515`
   前端现在把 `session.status === "planning"` 映射成占位意义上的 planning/executing 视图，但这不是 agent 的 `plan/build` mode，只是 session 生命周期状态。

这意味着当前仓库已经有“mode overlay 文案”，但没有“mode enforcement”。这正是外部调研最直接的落点。

## 3. `../opencode` 是怎么做的

### 3.1 核心建模：`plan/build` 是内建 agent

关键源码：

1. `../opencode/packages/opencode/src/agent/agent.ts:107-146`
2. `../opencode/packages/opencode/src/config/config.ts:935-968`
3. `../opencode/packages/web/src/content/docs/modes.mdx:6-16`

关键信息：

1. `build` 和 `plan` 都是内建 primary agent。
2. 配置层有 `default_agent`，默认回退到 `build`。
3. 老的 `mode` 配置仍存在，但文档已经明确 deprecated，推荐统一走 `agent`。

也就是说，`opencode` 的真实心智模型更接近：

```text
selected primary agent = build | plan
```

而不是一套独立的 permission mode 状态机。

### 3.2 差异主要体现在 per-agent permission

关键源码：`../opencode/packages/opencode/src/agent/agent.ts:86-146`

默认 permission 基座：

1. `* = allow`
2. `doom_loop = ask`
3. `external_directory = ask`
4. `question = deny`
5. `plan_enter = deny`
6. `plan_exit = deny`
7. `read` 默认允许，但 `.env` 相关路径会 ask

`build` 的增量规则：

1. `question = allow`
2. `plan_enter = allow`

`plan` 的增量规则：

1. `question = allow`
2. `plan_exit = allow`
3. 允许 plan 文件所在目录
4. `edit` 默认 deny，只对白名单 plan 文件放开

一个重要细节：当前真实源码里并没有在 `plan` agent 上显式 deny `bash`。因此它更像是：

1. 对编辑类工具做硬约束。
2. 对更广义的执行行为部分依赖 prompt/reminder 收敛。

### 3.3 运行时还有 reminder 注入和实验性 plan workflow

关键源码：

1. `../opencode/packages/opencode/src/session/prompt.ts:248-381`
2. `../opencode/packages/opencode/src/session/llm.ts:101-113`
3. `../opencode/packages/opencode/src/tool/plan.ts:19-70`

这里有两个层次。

轻量层：

1. 当前 agent 是 `plan` 时，会在最后一条 user message 上插入 `PROMPT_PLAN` synthetic text。
2. 从 `plan` 切回 `build` 时，会插入 `BUILD_SWITCH` synthetic text。

实验层：

1. experimental plan mode 打开后，runtime 会构造 plan file 路径。
2. 然后注入一整段 `<system-reminder>`。
3. 这段提醒明确规定：除 plan file 外不得编辑，主要做 read-only 行为，最终必须调用 `plan_exit`。

这套文本化 workflow 已经明显吸收了 `claude-code` 的设计。

### 3.4 `plan_exit` 负责切回实现阶段

关键源码：`../opencode/packages/opencode/src/tool/plan.ts:19-70`

`plan_exit` 的行为很直接：

1. 问用户是否切到 `build`。
2. 如果同意，写一条 synthetic user message。
3. 这条 user message 的 `agent` 直接设为 `build`。
4. 文本明确说明计划已批准，可以开始编辑文件并执行计划。

这说明 `plan approval` 不一定要先做复杂实体，也完全可以落成“特殊工具 + 一次确认 + 一条 synthetic message 切 mode”。

### 3.5 用户如何选择 `plan/build`

关键源码：

1. `../opencode/packages/opencode/src/config/config.ts:935-940`
2. `../opencode/packages/opencode/src/agent/agent.ts:285-309`
3. `../opencode/packages/opencode/src/cli/cmd/run.ts:254-262`
4. `../opencode/packages/opencode/src/cli/cmd/tui/app.tsx:550-612`

入口很多，但本质都围绕“选择当前 agent”：

1. config 里的 `default_agent`
2. CLI `--agent`
3. TUI agent picker / Tab cycle
4. API body 里的 `agent`

## 4. `../claude-code` 是怎么做的

### 4.1 核心建模：`plan` 是 permission mode，但没有独立 `build` mode

关键源码：

1. `../claude-code/src/types/permissions.ts:16-38`
2. `../claude-code/src/utils/permissions/PermissionMode.ts:42-91`
3. `../claude-code/src/utils/permissions/getNextPermissionMode.ts:38-78`

公开 permission modes 是：

1. `default`
2. `acceptEdits`
3. `bypassPermissions`
4. `dontAsk`
5. `plan`

内部还可能有 feature-gated 的 `auto`。

所以它的真实建模是：

```text
plan = 受限权限模式
implementation = 离开 plan 后回到 default / acceptEdits / bypassPermissions / auto 中的某一个
```

### 4.2 进入 plan mode：切 permission context，而不是切 agent

关键源码：

1. `../claude-code/src/commands/plan/plan.tsx:64-121`
2. `../claude-code/src/tools/EnterPlanModeTool/EnterPlanModeTool.ts:77-124`
3. `../claude-code/src/utils/permissions/permissionSetup.ts:1457-1493`

进入 plan mode 的核心动作：

1. 调用 `prepareContextForPlanMode()`。
2. 把当前 mode 存进 `prePlanMode`。
3. 将当前 `toolPermissionContext.mode` 切成 `plan`。

`prePlanMode` 非常关键。它意味着 `plan` 从一开始就是一个“临时覆盖层”，而不是永久身份。

### 4.3 plan mode 的核心工件是 plan file

关键源码：

1. `../claude-code/src/utils/plans.ts:79-144`
2. `../claude-code/src/utils/plans.ts:164-230`
3. `../claude-code/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:246-260`

plan file 的行为：

1. 默认目录是 `~/.claude/plans`。
2. 可通过 settings 指定 `plansDirectory`，但必须在项目根内。
3. 主会话 plan 文件名是 `{slug}.md`。
4. 子 agent plan 文件名是 `{slug}-agent-{agentId}.md`。
5. `getPlan()` 直接从磁盘读取 plan 内容。
6. resume 时如果 plan file 缺失，还会尝试从 file snapshot 或消息历史恢复。

这说明 `claude-code` 把“计划”当作独立、可恢复、可编辑、可审批的 durable artifact，而不只是 assistant 文本输出。

### 4.4 plan mode 的强约束不仅在权限层，也在模型可见 instructions 层

关键源码：

1. `../claude-code/src/utils/messages.ts:3323-3397`
2. `../claude-code/src/utils/messages.ts:3399-3416`
3. `../claude-code/src/tools/EnterPlanModeTool/EnterPlanModeTool.ts:103-124`

它会向模型注入很强的 plan-mode 指令，大意是：

1. 不得做任何系统变更。
2. 除 plan file 外不得编辑任何文件。
3. 只能做 read-only exploration。
4. 需要一边探索一边增量写 plan file。
5. 最终只能通过 `AskUserQuestion` 继续澄清，或者通过 `ExitPlanMode` 请求计划审批。

这些约束很多不是写死在 core system prompt 顶层，而是通过带 `<system-reminder>` 的 meta user messages 注入。

### 4.5 `ExitPlanMode` 是正式工作流，不只是切个开关

关键源码：

1. `../claude-code/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:195-239`
2. `../claude-code/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:243-417`
3. `../claude-code/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:431-491`

`ExitPlanMode` 做的事情远多于简单切换：

1. 只有当前 mode 真的是 `plan` 才允许调用。
2. 非 teammate 场景会强制走 approval UI。
3. 会从 plan file 读取计划内容；如果审批 UI 里用户编辑了计划，也会回写磁盘。
4. 如果是需要 leader 审批的 teammate，会把计划发到 mailbox。
5. 真正退出时，会把 mode 从 `plan` 恢复到 `prePlanMode`。
6. 返回给模型的 `tool_result` 里会带上批准后的计划正文。

所以在 `claude-code` 里，plan approval 的真实链路是：

```text
plan file
  -> ExitPlanMode
  -> permission / approval UI
  -> restore previous execution mode
  -> inject approved plan back to model
```

### 4.6 `claude-code` 没有真正的 `build` mode

关键源码：

1. `../claude-code/src/types/permissions.ts:16-38`
2. `../claude-code/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:483-489`
3. `../claude-code/src/utils/messages.ts:3428-3446`

离开 `plan` 后，模型得到的是“现在可以开始 coding/execute”的语义，但这并不是一个叫 `build` 的正式 mode，而只是恢复到某个非 `plan` 的执行权限模式。

## 5. 两种方案的本质差异

### 5.1 `opencode`：plan/build 是 agent identity

特点：

1. 认知负担低。
2. 实现成本相对低。
3. 很适合把 prompt、permission、tool visibility 全挂在 agent 上。
4. 后续如果再引入复杂 permission mode，容易和 agent 语义混在一起。

### 5.2 `claude-code`：plan 是 permission overlay，implementation 不是独立 mode

特点：

1. 更灵活，能和 `acceptEdits/auto/bypassPermissions` 叠加。
2. 更适合复杂 approval、auto mode、subagent、team 协作。
3. 实现成本和状态复杂度明显更高。
4. 需要成熟的 permission context、tool permission UI、plan artifact、恢复逻辑。

### 5.3 对当前仓库的真正启发

当前仓库两边都不像，但更接近“轻量 variant overlay”：

1. 没有 `opencode` 那样完整的 agent registry 和 per-agent permission。
2. 也没有 `claude-code` 那样完整的 `toolPermissionContext`、`prePlanMode`、plan file、mode cycle。
3. 但已经有：
   - `message.runtime.variant`
   - mode-aware system reminder
   - 完整的 tool approval / pause / resume 主链路

因此最适合的路线不是“照搬”，而是：

```text
variant = plan | build
  -> 真实控制 resolveTools 和后续切换流程
  -> 逐步补 plan approval / plan artifact
```

## 6. 对当前仓库的落地建议

### 6.1 总体建议：先围绕 `variant` 做轻量一等模式

建议把当前仓库的 `plan/build` 首版定义为：

1. `session.status` 继续表示会话生命周期：`planning | idle | executing | waiting_approval | ...`
2. `message.runtime.variant` 表示本轮 agent 行为模式：`plan | build`

这两个概念不要混用。`session.status` 解决的是 run orchestration，`variant` 解决的是模型行为与工具可见性。

### 6.2 首版最小闭环

我建议的 v1 目标不是 plan file，也不是新状态机，而是这 5 件事：

1. API 允许传 `variant`。
   - 扩展 `packages/shared/src/contracts.ts` 中的 `CreateSessionInput` 和 `SubmitSessionMessageInput`。
   - server 提交消息时把 `variant` 透传给 `normalizePrompt()`。
2. Web UI 增加 mode toggle。
   - 最小实现可以是 Composer 上方的 `Plan / Build` 二选一。
   - 新 session 默认值可以选择 `plan`。
3. `resolveTools()` 变成 mode-aware。
   - `plan` 时只暴露 `read`、`glob`、`grep`。
   - `build` 时暴露当前已有全量工具。
4. `toolOverrides` 只能在 mode 允许集合内生效。
   - 不能让用户通过 override 在 `plan` 模式强行打开 `write/edit/bash`。
5. 保留现有 `system-context.ts` 的 reminder overlay。
   - 这样 prompt 文案和实际可用工具就一致了。

这一步完成后，当前仓库就已经具备一个真正可用的只读 planning mode。

### 6.3 为什么不建议首版就上 plan file

虽然 `claude-code` 的 plan file 很强，但当前仓库首版不宜直接照搬，原因是：

1. 还没有专门的 plan artifact 持久化模型。
2. 还没有“审批前编辑计划内容”的 DetailPane UI。
3. 还没有 path-scoped 的特殊写权限豁免机制。
4. 一上来做 plan file，会把 mode feature 扩成“artifact + permissions + UI editor + approval editing + recovery”的复合项目。

更合理的顺序是：先让 plan 成为真实只读模式，先让计划以 assistant 文本产出，等 plan/build 工作流跑顺后，再决定是否把计划提升为 durable artifact。

### 6.4 第二阶段最值得借鉴的是 `plan_exit`

如果要做 plan approval，我最推荐借鉴的是 `opencode` 的 `plan_exit` 方向，并结合当前仓库已有 approval pipeline。

推荐做法：

1. 新增一个仅在 `variant === "plan"` 时可见的特殊工具，例如 `exit_plan_mode`。
2. 这个工具本身需要 approval。
3. 模型在完成计划后调用它。
4. runtime 进入现有的 `waiting_approval` / resume 主链路。
5. approval 通过后，工具结果负责生成一条 synthetic user message，把 `runtime.variant` 设为 `build`，并写入“计划已批准，开始实现”的文本。
6. 下一轮 run 自动继续，`system-context.ts` 已有的 `plan -> build` reminder 会自然生效。

这条路径的优势：

1. 复用了当前仓库已经成熟的工具审批与恢复机制。
2. 不需要先发明新的 plan approval 实体类型。
3. 在产品语义上已经很接近 `opencode` 和 `claude-code` 的计划批准切换体验。

### 6.5 `resolveTools()` 的推荐过滤顺序

结合当前仓库已有 RFC 和本次研究，我建议 `resolveTools()` 的顺序明确为：

1. 工具定义基础集合
2. mode policy 过滤
3. 后续如有需要，再加 agent policy 或 session policy
4. 最后才应用 last-user `toolOverrides`

其中最重要的原则是：override 只能缩小或关闭工具，不应该越权打开 mode 不允许的工具。否则 `plan` 模式就只是提示词，而不是产品能力。

## 7. 推荐实施顺序

如果接下来就在本仓库开始开发，我建议按下面顺序推进：

1. 阶段 1：让 `variant` 从 API 到 UI 到 `resolveTools()` 全链路打通，形成真正可用的只读 plan mode。
2. 阶段 2：新增 `exit_plan_mode`，让“计划完成 -> 用户批准 -> 自动切回 build”成为正式工作流。
3. 阶段 3：只有在确认确实需要 durable 计划工件时，再评估引入 plan artifact 或 plan file。

## 8. 我认为最应该直接参考的源码

如果要继续往下实现，最值得反复读的文件是：

1. `../opencode/packages/opencode/src/agent/agent.ts`
2. `../opencode/packages/opencode/src/session/prompt.ts`
3. `../opencode/packages/opencode/src/tool/plan.ts`
4. `../claude-code/src/types/permissions.ts`
5. `../claude-code/src/tools/EnterPlanModeTool/EnterPlanModeTool.ts`
6. `../claude-code/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts`
7. `../claude-code/src/utils/plans.ts`
8. `../claude-code/src/utils/messages.ts`

对于当前仓库，最关键的改造落点则是：

1. `packages/shared/src/contracts.ts`
2. `apps/server/src/services/agent/interaction-service.ts`
3. `packages/agent/src/context/tool-registry.ts`
4. `packages/agent/src/context/system-context.ts`
5. `apps/web/src/features/chat/composer.tsx`
6. `apps/web/src/router.tsx`
