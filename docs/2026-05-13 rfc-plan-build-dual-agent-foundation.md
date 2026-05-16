# RFC: plan/build 双模式基础能力落地

Status: Proposed

Owner: OpenCode

Last Updated: 2026-05-13

Audience: 人类维护者、coding agent

## 1. 背景

当前项目已经具备一个可运行的 coding agent 主链路：

```text
ContextBuilder
  -> resolveTools()
  -> AiSdkRequestAdapter
  -> SessionProcessor
  -> RunLoop
  -> Lifecycle
```

同时，项目内部其实已经埋下了 plan/build 模式的一部分基础：

1. `packages/agent/src/prompt.ts` 的 `normalizePrompt()` 已支持 `agentName` 和 `variant`。
2. `packages/agent/src/context/system-context.ts` 已支持基于 `runtime.variant` 注入只读 planning overlay 和 `plan -> build` 切换提示。
3. `packages/agent/src/context/builder.ts` 已以最后一条 user message 的 `agentName` 作为本轮上下文中的 `agentName`。
4. `packages/shared/src/dto.ts` 中 `MessageDto.agentName`、`SessionDto.currentPlanId/currentTaskId`、`SessionCheckpoint.kind` 等字段已经为更强的阶段化运行时做了预留。
5. `packages/orm/src/schema.ts` 里也已经存在 `plans`、`tasks`、`currentPlanId`、`currentTaskId` 等 schema 痕迹。

但是，当前系统距离真正可用的 plan/build 双模式还有明显缺口：

1. `resolveTools()` 还不根据 `agentName` 或 mode 做工具过滤。
2. API 和前端还没有显式的 `plan/build` 选择入口。
3. planning 的只读约束还主要依赖 prompt 文案，而不是运行时真实限制。
4. `plan -> build` 还没有正式的切换工作流，只存在很轻的 prompt reminder。

用户当前明确希望做的是类似 `../opencode` 的产品心智：

1. UI 上明确存在 `plan` 和 `build` 两种模式。
2. 用户和 runtime 都清楚当前选中的是哪个模式。
3. `plan` 与 `build` 的 prompt、工具集和行为边界有硬差异。

本 RFC 覆盖以下 5 个步骤：

1. 增加 plan/build 模式选择入口。
2. 建立 mode-aware 的工具过滤与权限收敛。
3. 明确 `plan` 和 `build` 两种模式的行为边界。
4. 将 runtime overlay 从“轻量 variant 提示”收敛为正式的 dual-mode prompt 体系。
5. 设计 `plan -> build` 的正式切换工作流。

本 RFC 不包含 session 级 task 系统，task 能力将在独立 RFC 中定义。

## 2. 设计输入

本 RFC 的主要设计输入有三类。

### 2.1 当前项目现状

当前项目最关键的相关实现如下：

1. `packages/agent/src/context/builder.ts:333-385`
   本轮请求所用的 `agentName` 来自最后一条 user message。
2. `packages/agent/src/context/tool-registry.ts:12-28`
   当前工具暴露只做了 last-user `toolOverrides` 合并，不看 agent 权限。
3. `packages/agent/src/context/system-context.ts:45-100`
   已存在基于 `runtime.variant` 的 planning/build system reminder。
4. `apps/server/src/services/agent/interaction-service.ts:63-147`
   prompt 入口当前没有暴露 `plan/build` 模式选择面。
5. `apps/web/src/features/chat/composer.tsx`
   Composer 目前只有文本输入，没有模式切换能力。

### 2.2 从 `../opencode` 借鉴的点

`../opencode` 当前对 plan/build 的真实建模更接近“内建 agent”，关键点如下：

1. `../opencode/packages/opencode/src/agent/agent.ts`
   - 内建 primary agents：`build`、`plan`
   - 内建 subagents：`general`、`explore`
2. `../opencode/packages/opencode/src/config/config.ts`
   - `default_agent`
   - `agent.*` 配置结构
3. `../opencode/packages/opencode/src/session/prompt.ts`
   - 运行时注入 plan/build synthetic reminders
4. `../opencode/packages/opencode/src/tool/plan.ts`
   - `plan_exit` 通过一次确认切换回 `build`
5. `../opencode/packages/opencode/src/tool/registry.ts`
   - tool registry 在运行时接收当前 agent，工具定义可以感知 agent

本项目最值得借鉴的点：

1. `plan/build` 作为显式产品模式，对用户和实现都更清晰。
2. mode 可以同时决定自己的 prompt、permission 和 tool visibility。
3. `plan -> build` 可以通过一个独立的“模式切换工具”走正式工作流。

### 2.3 对 `../claude-code` 的取舍

`../claude-code` 的 `plan` 是 permission overlay，不是当前 RFC 想要的双模式产品形态。它的优势在于更适合复杂的 auto/team/approval 组合，但当前项目还不适合直接照搬，原因是：

1. 当前项目没有 `toolPermissionContext` 这类成熟 permission state machine。
2. 当前项目也没有 `prePlanMode`、plan file、plan approval dialog 等配套体系。
3. 当前阶段最需要的是“让 plan 真正只读”和“让 build 真正执行”，而不是一套高度组合化的权限系统。

因此，本 RFC 明确选择偏向 `../opencode` 的双模式产品路线，但运行时唯一事实源保持为 `runtime.variant`。

## 3. 目标

本 RFC 的目标如下：

1. 将 `plan` 和 `build` 明确落成两个一等运行模式。
2. 保持当前 session/run/message/tool_call/approval 主链路基本不重写。
3. 让 API、服务层、前端和 runtime 都以同一个事实源表达“当前模式是 `plan` 还是 `build`”。
4. 让 `plan` 成为真正的只读 planning mode，而不是只靠文案收敛。
5. 让 `build` 成为真正的 implementation mode。
6. 让 `plan -> build` 切换有清晰的运行时语义，并为后续审批驱动切换保留扩展点。

## 4. 非目标

本 RFC 首版明确不做以下事情：

1. 不在本 RFC 中引入 session 级 task 数据结构与 API。
2. 不在本 RFC 中引入 plan file。
3. 不在本 RFC 中实现 `claude-code` 级别的 permission mode、auto mode、team/swarm。
4. 不在本 RFC 中一次性引入 `reviewer`、`frontend`、`backend` 等多角色 agent 体系。
5. 不在本 RFC 中重写现有 approval 数据模型。

## 5. 核心判断

### 5.1 当前项目适合把 `variant` 作为唯一事实源

对于当前项目，`plan/build` 最合适的落点不是新的 `agentName` 身份层，而是正式的 `runtime.variant`：

```text
message.runtime.variant = plan | build
```

原因：

1. `packages/agent/src/context/system-context.ts` 当前已经完整依赖 `runtime.variant` 产生 planning/build overlay。
2. 当前项目还没有真正的 agent registry、per-agent prompt config、per-agent model config，因此过早把 `plan/build` 建模成独立 agent 身份层会平白增加一层概念。
3. 对当前产品来说，用户真正需要的是“当前在 `plan` 还是 `build` 模式”，而不是更复杂的 agent 类型系统。
4. 只保留 `variant` 一个事实源，可以避免 `agentName=plan` 但 `runtime.variant=build` 这类双真相冲突。

### 5.2 `plan` 不应仅仅是“禁止写文件”

`plan` 首版如果只禁 `write/edit/apply_patch`，但保留 `bash`，实际上仍然可以：

1. 改 git 状态
2. 运行带副作用脚本
3. 间接写文件
4. 修改环境或依赖

这会让 “planning mode” 失去产品可信度。

因此，本 RFC 建议 `plan` 首版只暴露真正的只读工具：

1. `read`
2. `glob`
3. `grep`

而不是“除了写工具外都保留”。

### 5.3 `toolOverrides` 只能缩小权限，不能越权启用

当前 `resolveTools()` 会把 last-user `runtime.toolOverrides` 直接作为最终 enable/disable 开关，这在双模式体系下必须修改。

正确语义应为：

1. 系统或 agent 禁用 = 硬禁用。
2. 用户 `toolOverrides[name] = false` = 本轮主动关闭已允许工具。
3. 用户 `toolOverrides[name] = true` = 只在 agent 允许集合内启用，不能突破硬禁用。

### 5.4 `variant` 应成为唯一模式真相

本 RFC 采用以下原则：

1. `runtime.variant` 是 plan/build 模式的唯一事实源。
2. `agentName` 继续保留给当前项目已有或未来可能引入的其他 agent 概念，但本 RFC 不把它用于 plan/build 建模。
3. 只要涉及 plan/build 的 prompt、工具过滤、前端展示和切换工作流，都统一读取和写入 `runtime.variant`。

### 5.5 `plan -> build` 应分阶段交付

`plan -> build` 切换工作流不必一次到位。建议分成两个阶段：

第一阶段：

1. 用户在前端显式切换模式。
2. 下一条 user message 使用 `variant=build`。

第二阶段：

1. 新增一个仅在 `plan` 下可见的 `exit_plan_mode` 工具。
2. 该工具通过现有 approval/resume 链路切换到 `build`。

这样既能尽快交付可用模式，也能为正式“确认计划后执行”工作流留出路径。

## 6. 总体方案

### 6.1 数据与输入建模

首版保持“session 级默认模式 + 消息级显式模式”的组合建模。

建议：

1. `CreateSessionInput` 增加：

```ts
defaultVariant?: 'plan' | 'build'
```

2. `SubmitSessionMessageInput` 增加：

```ts
variant: 'plan' | 'build'
```

3. 新建 session 时若未指定 `defaultVariant`，默认使用 `plan`。
4. 前端正常产品路径中，发送用户消息时必须显式提交 `variant`。
5. 服务端将该值写入 `message.runtime.variant`。
6. 仅为旧客户端、测试或内部调用保留兜底逻辑：如果缺失 `variant`，则优先继承上一条 user message 的 `runtime.variant`，否则回退为 session 的 `defaultVariant`，若仍不可得则回退 `plan`。

### 6.2 内建 mode 定义

建议在 `packages/agent` 中新增明确的 mode definition 层，类似：

```ts
type BuiltinVariant = 'plan' | 'build';

type BuiltinVariantDefinition = {
  name: BuiltinVariant;
  description: string;
  allowedTools: ToolName[];
  promptOverlay: BuiltinVariant;
};
```

首版内建：

1. `plan`
   - description: 用于调研、分析、制定执行方案
   - allowedTools: `read` / `glob` / `grep`
2. `build`
   - description: 用于根据确认后的方案执行代码修改和验证
   - allowedTools: 当前已有全部核心工具

该定义层不需要一开始就做成 `../opencode` 那样完全开放的 config 系统，但结构上应留出扩展空间。

### 6.3 `resolveTools()` 改造

建议将 `resolveTools()` 的过滤顺序明确为：

```text
builtin registry
  -> variant allowlist filter
  -> future session/workspace policy filter
  -> last-user override (only narrowing / non-escalating)
```

首版具体规则：

1. `plan`
   - allow: `read`, `glob`, `grep`
   - deny: `apply_patch`, `bash`, `edit`, `write`
2. `build`
   - allow: 当前已有全量工具

### 6.4 system prompt 与 overlay

当前 `packages/agent/src/context/system-context.ts` 已有 `variant` overlay 文案。首版建议：

1. 保留现有结构：`core` + `environment` + `instruction`。
2. 继续以 `runtime.variant` 作为唯一判定依据。
3. 首版仍保留 `plan -> build` 过渡提醒文案。

建议新增的稳定语义：

1. `plan` mode：
   - 你处于 planning mode
   - 你只能做 inspection / explanation / planning
   - 不得进行文件编辑或 shell 操作
2. `build` mode：
   - 你处于 implementation mode
   - 你应优先实际执行和验证，而不是停留在分析
3. `plan -> build`：
   - 计划阶段已经结束
   - 现在可以开始实现

### 6.5 前端入口

建议在 `apps/web` 增加双模式选择入口：

1. 创建 session 时可选默认模式，默认 `plan`。
2. session 页面中在 Composer 或顶部栏暴露 `Plan / Build` 切换。
3. 当前激活模式应在 UI 中明确可见，而不是依赖用户猜测。

推荐首版使用最小交互：

1. 一个二选一 segmented control
2. 当前值进入 `submitSessionMessage()` payload 的 `variant`
3. session 首屏也展示当前默认模式

### 6.6 切换工作流

首版切换：

1. 纯手动切换
2. 用户在前端选择 `build`
3. 下一条消息开始使用 `variant=build`

二期切换：

1. 新增 `exit_plan_mode` 工具
2. 仅在 `plan` mode 可见
3. 默认要求 approval
4. 批准后写入一条 synthetic user message：
   - `runtime.variant = build`
   - `content = 计划已批准，开始执行`
5. runtime 继续下一轮执行

这一步设计与 `../opencode/packages/opencode/src/tool/plan.ts` 保持同类心智，但接入当前项目已有 approval/resume 主链路。

## 7. 实施拆分

### 7.1 第 1 批：双模式基础能力

目标：让 `plan/build` 成为真实可用的运行时模式。

包含：

1. contracts 增加 `defaultVariant` 和 `variant`
2. server prompt 入口透传 `variant`
3. 前端 mode selector
4. `resolveTools()` 按 mode 过滤
5. system overlay 按 `runtime.variant` 生效

完成标准：

1. `plan` 时模型看不到写工具和 `bash`
2. `build` 时恢复全量工具
3. 前端能显式切换
4. mode 选择能持久化到消息并影响下一轮

### 7.2 第 2 批：正式切换工作流

目标：让“计划完成 -> 切到 build”成为正式工作流。

包含：

1. `exit_plan_mode` 工具
2. approval 驱动的切换
3. synthetic user message 切 mode

## 8. 对现有代码的建议改动点

首版预计主要涉及：

1. `packages/shared/src/contracts.ts`
2. `packages/agent/src/prompt.ts`
3. `packages/agent/src/context/tool-registry.ts`
4. `packages/agent/src/context/system-context.ts`
5. `apps/server/src/services/session/service.ts`
6. `apps/server/src/services/agent/interaction-service.ts`
7. `apps/web/src/lib/api.ts`
8. `apps/web/src/features/chat/composer.tsx`
9. `apps/web/src/router.tsx`

二期预计还会涉及：

1. `packages/agent/src/tools/*`
2. `packages/agent/src/tool-executor.ts`
3. `apps/server/src/services/agent/*`
4. `apps/web/src/features/approvals/*`

## 9. 验证建议

至少补以下测试：

1. `plan` mode 只暴露 `read/glob/grep`
2. `build` mode 暴露当前全量工具
3. `toolOverrides` 不能越权打开 `plan` 禁止工具
4. `variant=plan` 时 system overlay 正确
5. `plan -> build` 切换后过渡提醒正确

## 10. 与后续 RFC 的关系

本 RFC 是 session 级 task 系统的前置基础。

原因：

1. task 的最主要使用场景是 `plan` 拆任务、`build` 执行任务。
2. 如果先没有双模式，task 很难形成清晰产品语义。
3. 因此 task RFC 应建立在本 RFC 完成后再落地。
