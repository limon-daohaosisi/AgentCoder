# RFC: 面向缓存的上下文重构、全量工具暴露与目录级 AGENTS.md 动态注入

Status: Proposed

Owner: OpenCode

Last Updated: 2026-05-26

Audience: 人类维护者、coding agent

## 1. 背景

当前项目已经具备可运行的 agent 主链路：

```text
Composer
  -> SessionInteractionService.prompt()
  -> Lifecycle.startPromptRun()
  -> RunLoop.run()
  -> ContextBuilder.build()
  -> resolveTools()
  -> toAiSdkTurnRequest()
  -> SessionProcessor.processTurn()
```

当前 system prompt 由以下几部分拼装而成：

1. `core system prompt`
2. workspace 根级 `AGENTS.md`
3. `environment`
4. `runtime instructions`

对应实现见：

1. `packages/agent/src/prompt/core-sections.ts`
2. `apps/server/src/services/agent/workspace-memory-service.ts`
3. `packages/agent/src/context/system-context.ts`
4. `packages/agent/src/context/prompt-bundle.ts`

当前实现已经能工作，但从上下文质量和提示词缓存命中率来看，存在四类结构性问题。

第一，system 通道里混入了过多高波动运行时信息。例如：

1. `runtime.variant`
2. `transitionedFromPlan`
3. `planContext.filePath`
4. `userSystem`
5. `format.schema`
6. `environment` 中的 `model`、`agentName`、`workspaceRoot`

这些内容中的一部分属于系统级强约束，但另一部分更像“本轮运行上下文”。当前它们全部进入 `system`，会使 system 前缀字节频繁变化，削弱后续大段历史消息的可复用性。

第二，当前工具暴露策略在 `plan/build` 模式下直接切两套工具集合。`resolveTools()` 当前会：

1. 在 `plan` 模式下只开放 `read/glob/grep/task_*/write/edit/plan_exit`
2. 在 `build` 模式下禁用 `task_create/plan_exit`

对应实现见 `packages/agent/src/context/tool-registry.ts`。这会导致每次模式切换时，tool schema 本身也成为高波动前缀，进一步伤害缓存命中率。

第三，`plan` 模式下的 plan file 生命周期不够合理。当前 `SessionInteractionService.prompt()` 只要发现 `variant === 'plan'`，就会立即调用 `planService.getOrCreateCurrentPlan()`，从而为 session 创建 current plan 记录，并且通过 `planFileService` 暗含一个 plan file path。再叠加当前 `write/edit` 对“当前 plan file”放行的策略，模型很容易在没有真正形成计划前就留下大量空白或半空白模板文件。这使 plan artifact 像是 runtime 强推出来的占位物，而不是模型真实形成计划后的 durable output。

第四，项目目前只支持 workspace 根目录 `AGENTS.md` 注入，不支持随着模型实际深入到某个子目录，再把该子目录链路上的 `AGENTS.md` 动态补入上下文。这使 monorepo 或多模块项目在深路径工作时，局部规则无法自然进入模型上下文。

本 RFC 的目标，是在保持当前主链路和数据模型大体不推倒重来的前提下，对 `tool/system/message` 三层上下文做一次面向缓存和可扩展性的重构，并引入轻量版目录级 `AGENTS.md` 动态注入机制。

## 2. 设计输入

### 2.1 当前项目现状

当前项目与本 RFC 直接相关的实现如下：

1. `packages/agent/src/context/system-context.ts`
   - 负责构建 `core`、`environment`、`instruction`、`user_system`、`format`
2. `packages/agent/src/context/prompt-bundle.ts`
   - 负责拼接 system block 顺序
3. `apps/server/src/services/agent/workspace-memory-service.ts`
   - 只读取 workspace 根级 `AGENTS.md`
4. `packages/agent/src/context/tool-registry.ts`
   - 按 `variant` 过滤工具集合
5. `packages/agent/src/tools/write/index.ts`
   - 已具备 `assertPlanFileWriteAllowed()` 的 current plan file 特判
6. `packages/agent/src/tools/edit/index.ts`
   - 同样具备 current plan file 特判
7. `apps/server/src/services/session/plan-service.ts`
   - `getOrCreateCurrentPlan()` 当前是 plan workflow 的入口锚点
8. `packages/shared/src/dto.ts`
   - 已有 `MessageRuntimeMetadata.userSystem/format/variant/toolOverrides`

### 2.2 从 `../claude-code` 借鉴的点

本 RFC 借鉴 `../claude-code` 的四个关键机制：

1. **稳定 system 前缀与动态上下文分离**
   - 主 system prompt 尽量稳定
   - 动态模式提醒、目录记忆、运行时提示尽量进入 `messages`
2. **工具集合尽量稳定**
   - 不因 mode 直接切两套 schema
   - 通过 prompt、attachment、permission 约束模型行为
3. **路径触发的目录级 memory 注入**
   - 不是靠 workspace 变化
   - 而是靠模型实际触碰到的文件路径来触发目录级记忆注入
4. **attachment 最终进入 message 通道**
   - attachment 不是额外 API 顶层字段
   - 最终会被归一化为 message side 的 meta context

### 2.3 对 OpenAI 路径的特殊约束

当前项目主链路走的是 OpenAI-compatible provider，经由 AI SDK 的：

1. `messages`
2. `openai.instructions`
3. `tools`

发起请求。

与 Anthropic 不同，OpenAI 当前公开的 prompt caching 能力更偏“自动 exact-prefix caching”，并没有提供明确的 `cache_control` breakpoint 语义。因此，本项目不能直接照搬 `claude-code` 的全部 cache breakpoint 设计，而是应采用以下原则：

1. 稳定内容尽量放前
2. 高波动内容尽量离开 system 前缀
3. 工具 schema 尽量会话内稳定
4. 目录级运行时记忆尽量走 message 通道

## 3. 目标

本 RFC 的目标如下：

1. 将当前项目的工具暴露改为“默认全量工具注入”，不再按 `plan/build` 切两套 tool schema。
2. 保留并强化 `plan/build` 在 system 或 message 层面的行为约束，使 `plan` 仍然是只读 planning mode。
3. 将 system 中高波动的运行时上下文拆出，改为 attachment/message 注入。
4. 为当前项目引入 attachment 归一化与局部重排机制，使动态上下文不污染主 system 前缀。
5. 调整 `plan` 模式下 plan file 的创建策略：不再由 runtime 预先制造空 plan 模板，而是由模型在真正需要时创建。
6. 引入目录级 `AGENTS.md` 动态注入：当模型实际读取某个子路径下的文件时，动态补入从 workspace root 到该目标目录链上的 `AGENTS.md`。
7. 为 compact 后的上下文恢复定义明确行为，保证基础 project memory 重建、目录级 memory 可按路径再次触发。
8. 避免重复叠加当前项目已经具备的 mode/tool 约束文案，只在现有提示不足以支撑全量工具暴露后才补新的规则文本。

## 4. 非目标

本 RFC 首版明确不做以下内容：

1. 不兼容 `CLAUDE.md`、`.claude/rules`、frontmatter `paths`、`@include` 等高级 instruction 系统。
2. 不引入 Anthropic 式 `cache_control` breakpoint。
3. 不重做 approval 数据模型。
4. 不为 `AGENTS.md` 建数据库持久化表。
5. 不实现目录级 `AGENTS.md` 的条件匹配规则，只做沿路径链的无条件层叠注入。
6. 不在首版实现 tool schema 的显式 session cache 存储层，但会在设计中为其留接口。
7. 不修改现有 `task_*` 领域数据模型，只调整它们在 plan/build 模式下的提示与推荐行为。

## 5. 核心判断

### 5.1 当前项目应该让工具集合稳定，而不是让 mode 改写工具集合

当前 `tool-registry.ts` 的 `variant -> tool filtering` 做法，会让 `plan -> build` 切换同时改变：

1. system prompt
2. tool schema
3. tool policies

这对缓存最不友好。

本 RFC 采用以下判断：

1. **模型可见 tool schema 默认全量稳定暴露**
2. `plan/build` 只改变：
   - system/message 侧约束
   - runtime 执行时的权限判断
   - 审批模式
3. `toolOverrides` 只能缩小可见工具集合，不能扩大超出 runtime hard policy 的能力

### 5.2 mode 约束应分成“system 强约束”和“message 动态上下文”两层

不是所有动态信息都应该搬出 system。

本 RFC 采用以下分层：

1. **保留在 system 的**
   - `core prompt`
   - workspace 根级 `AGENTS.md`
   - `variant` 的抽象行为约束
   - `format.schema`
2. **移出 system 进入 attachment/message 的**
   - `transitionedFromPlan`
   - `plan file path`
   - `agentName`
   - `workspaceRoot`
   - 目录级 `AGENTS.md`
   - 其他 read-triggered 局部上下文

原因：

1. `variant` 仍然是系统级“能做什么、不能做什么”的核心约束
2. 而 `plan file path`、子目录记忆、运行时观察到的路径信息，更像当前工作上下文

额外原则：

1. 若当前 `core` 或 `variant overlay` 已经能表达某项 mode 约束，则不重复新增近义规则
2. 首版以“挪走高波动信息”和“把硬约束下沉到执行层”为主，不追求文案数量增加

### 5.3 plan file 不应该由 runtime 先造空模板，而应由模型显式创建

当前 `planService.getOrCreateCurrentPlan()` 过早承担了“生成当前 plan artifact”的职责。

本 RFC 采用以下判断：

1. session 级 current plan anchor 仍然保留
2. 但 current plan file 的磁盘文件不再因为进入 `plan` 模式而自动落地
3. 模型需要时，应显式使用 `write` 创建该 plan file
4. `edit` 仅在文件已经存在时对其增量修改

这样可避免：

1. 空模板污染本地工作区
2. 多个 session 产生大量空 plan 文件
3. 模型在没有真正完成 planning 前就被动产生 artifact

### 5.4 目录级 AGENTS.md 应该是 read-triggered attachment，而不是 eager system prefix

目录级记忆若一上来全部读入 system，会产生两个问题：

1. system 前缀膨胀
2. 与当前任务无关的深层模块规则过早进入上下文

因此，本 RFC 采用：

1. workspace root `AGENTS.md` 继续作为基础 project memory 进 system
2. 子目录 `AGENTS.md` 只在模型实际读到该路径下文件时，沿路径链动态补入
3. 动态补入走 attachment/message 通道

### 5.5 compact 后应“重建基础 memory，懒恢复目录级 memory”

本 RFC 明确 compact 后的期望语义：

1. 根级 `AGENTS.md` 重新由 `ContextBuilder` 每轮读取并进入 system
2. 目录级 `AGENTS.md` 的动态注入状态清空
3. 后续只要再次 read 到相关路径，就重新注入该目录链的 `AGENTS.md`

这比“强行把所有目录级记忆都恢复回 post-compact messages”更稳，更省 token。

## 6. 总体方案

### 6.1 上下文三层重构

#### 6.1.1 tool 层

当前：

1. `plan/build` 直接切不同工具集合

改为：

1. `toolRegistry` 默认全量参与 `resolveTools()`
2. `variant` 不再决定工具是否对模型可见
3. `toolOverrides` 只做用户侧缩减
4. 运行时执行时再根据 mode 做 hard policy 判断

首版保持以下例外：

1. `task_update` 的 build-only execution schema 特判可继续保留
2. 但这应迁移为“同一工具、同一可见性、不同输入校验/执行约束”，而不是消失/出现

#### 6.1.2 system 层

新的 system 结构调整为：

1. `core`
2. workspace root `AGENTS.md`
3. `mode rules`
4. `format`

从 system 中移除：

1. `environment` block 整体
2. `transitionedFromPlan` 特殊提醒
3. `plan file path`
4. `agentName`
5. `workspaceRoot`

是否完全删除 `environment` 的讨论：

1. 对模型而言，`platform`、`cwd`、`agentName` 属于有用上下文
2. 但它们不必在 system 中
3. 因此本 RFC 选择保留其信息价值，但迁移到 attachment/message

#### 6.1.3 message 层

新增 runtime attachment/message 通道，用于承载：

1. `environment context`
2. `plan_mode` / `build_mode` 动态提醒
3. `plan_transition`
4. `plan_file_reference`
5. `nested_agents_memory`

这些内容最终都变成：

1. `MessagePart.type = 'summary'` 或新增 `runtime_context`
2. 或在 `ContextBuilder` 投影时统一转成 user-side text part

首版推荐新增一个新的 message part 类型：

```ts
type RuntimeContextPart = {
  type: 'runtime_context';
  kind:
    | 'environment'
    | 'mode_state'
    | 'mode_transition'
    | 'plan_file'
    | 'nested_agents_memory';
  text: string;
  metadata?: Record<string, unknown>;
};
```

这样可以：

1. 与普通 user message 区分
2. 为后续局部重排保留类型信息
3. 避免滥用 `summary`

### 6.2 attachment 机制

#### 6.2.1 运行时 attachment 生成时机

新增 `RuntimeAttachmentService`，由 server 侧提供。它在每轮执行前，根据当前 session state 和最近一次工具触发的路径，生成 attachment parts。

建议 attachment 生成分两类：

1. **pre-turn attachments**
   - mode state
   - environment context
   - plan transition
2. **path-triggered attachments**
   - nested `AGENTS.md`

#### 6.2.2 attachment 的最终落点

首版不引入额外顶层 API 字段。

attachment 最终仍然会变成 message 通道的一部分：

1. 在 durable message 流中以 synthetic `user` message 持久化
2. 该 synthetic `user` message 的内容 part 使用 `runtime_context`
3. `ContextBuilder.projectMessage()` 时将 `runtime_context` part 投影为 user-side text

这与 `claude-code` 的策略一致：attachment 不是额外模型字段，而是内部消息表示，最终进入 `messages`。

#### 6.2.3 attachment 重排规则

新增类似 `claude-code` 的局部重排函数，但首版可以更简单。

规则如下：

1. `runtime_context` part 默认附着在最近一个 assistant/tool-result 边界之后
2. 不能插入 tool result 配对中间
3. 不能越过 assistant 边界向前漂移
4. 可与相邻 user-side context part 合并

首版最小实现可不做全局 message reorder，而采用：

1. 在服务端插入 synthetic user message
2. 插入位置为：
   - 若最近一条消息是当前轮新用户消息，则插在它之前
   - 若最近一条是 assistant/tool message，则插在它之后

更直接地说，首版应实现的目标不是完整复刻 `reorderAttachmentsForAPI()`，而是满足：

```text
[assistant boundary]
[runtime attachment context]
[current user prompt]
```

这样既不污染 system，也不把动态上下文压在绝对尾部。

### 6.3 plan/build 工具与执行约束

#### 6.3.1 模型可见工具

模型永远看到全量 builtin tools：

1. `read`
2. `glob`
3. `grep`
4. `task_*`
5. `plan_exit`
6. `write`
7. `edit`
8. `bash`
9. `apply_patch`

#### 6.3.2 plan 模式 hard policy

虽然模型可见全量工具，但 runtime 必须 enforce：

1. `bash`
   - 禁止
2. `apply_patch`
   - 禁止
3. `write`
   - 仅允许当前 plan file
4. `edit`
   - 仅允许当前 plan file

这部分当前 `write/edit` 已具备 plan file 放行能力，只需从“变体工具裁剪”迁移为“统一工具下的执行期限制”。

#### 6.3.3 build 模式 hard policy

1. `plan_exit`
   - 对模型可见，但调用时直接报错，提示当前不在 plan mode
2. `write/edit/apply_patch/bash`
   - 正常按现有审批模式处理
3. `task_create`
   - 不再通过 tool visibility 隐藏
   - 是否建议使用由 prompt 约束，而不是 schema 层禁掉

### 6.4 plan file 生命周期调整

#### 6.4.1 current plan anchor 与 plan file 分离

保留：

1. `PlanDto`
2. `session.currentPlanId`

但修改 `planService.getOrCreateCurrentPlan()` 的语义：

1. 允许 current plan 记录存在
2. 但不强制对应 plan file 已落盘

#### 6.4.2 plan file 创建规则

调整为：

1. 进入 `plan` 模式时不再自动写模板
2. 只有当模型显式使用 `write` 创建当前 plan file 时，文件才落盘
3. `edit` 仅在文件存在时可用
4. `plan_exit` 若当前 plan file 不存在，则报错并提示模型先形成计划文件

#### 6.4.3 system/message 约束相应调整

当前 system 提示里有：

1. “If the file does not exist yet, create it with write. If it already exists, refine it with edit.”

这条语义可以保留，但要从强制模板生成改为：

1. 由模型自行决定何时第一次写 plan file
2. runtime 只保证 file path 可被合法写入

### 6.5 目录级 AGENTS.md 动态注入

#### 6.5.1 触发器

首版以 `read` 工具为主触发器。

执行 `read` 成功后：

1. 将目标文件路径写入 `nestedAgentsMemoryTriggers`

后续可扩展到：

1. `glob`
2. `grep`
3. IDE opened file

但首版建议先只做 `read`，减少路径噪声。

#### 6.5.2 目录遍历规则

给定：

1. `workspaceRoot`
2. `targetFilePath`

构造目录链：

```text
workspaceRoot -> ... -> dirname(targetFilePath)
```

然后对这条链的每一层尝试读取：

```text
<dir>/AGENTS.md
```

按从浅到深顺序注入。

这样更符合“离目标路径越近优先级越高”的规则。

#### 6.5.3 去重与缓存

新增两个 runtime 集合：

1. `loadedNestedAgentsMemoryPaths`
2. `nestedAgentsMemoryTriggers`

语义分别为：

1. 本 session 已经作为 attachment 注入过的子路径 `AGENTS.md`
2. 本轮由 read 触发、等待注入的文件路径

compact 后：

1. `loadedNestedAgentsMemoryPaths.clear()`
2. `nestedAgentsMemoryTriggers.clear()`

这样后续再次访问相关路径时可以重新注入。

#### 6.5.4 与 workspace 根级 AGENTS.md 的关系

1. 根级 `AGENTS.md` 继续走 system memory
2. 动态目录注入时，如果路径链包含 workspace root，本层 root `AGENTS.md` 需去重，不重复作为 attachment 再注一次

### 6.6 compact 语义

compact 后必须保证：

1. `get root AGENTS.md -> system` 的基础路径继续有效
2. 动态目录记忆不强行恢复
3. 若后续又 read 到相关路径，则重新注入

因此 compact 后新增 cleanup 行为：

1. 清空 nested agents memory 的 loaded/trigger state
2. 不把目录级 `AGENTS.md` 纳入 post-compact file restore
3. 下一轮 `ContextBuilder` 正常重建基础 root `AGENTS.md`

## 7. 详细改动

### 7.1 shared types

在 `packages/shared/src/dto.ts` 中新增：

1. `MessagePart.type = 'runtime_context'`
2. `MessagePartRuntimeContextKind`

并为 `CreateMessagePartInput` 补齐对应输入类型。

### 7.2 agent context builder

修改 `packages/agent/src/context/system-context.ts`：

1. 删除 `buildEnvironmentSystemBlock()`
2. `buildRuntimeInstructionBlocks()` 仅保留：
   - `variant` 抽象行为约束
   - `userSystem`
   - `format`
3. 删除对：
   - `plan file path`
   - `workspaceRoot`
   - `agentName`
   - `model id`
     的直接 system 注入

修改 `packages/agent/src/context/prompt-bundle.ts`：

1. system 顺序收敛为：
   - `core`
   - `root memory`
   - `mode rules`
   - `user_system`
   - `format`

### 7.3 server runtime attachment service

新增建议文件：

1. `apps/server/src/services/agent/runtime-attachment-service.ts`
2. `apps/server/src/services/agent/nested-agents-memory-service.ts`

职责：

1. 计算 pre-turn runtime attachments
2. 计算 path-triggered nested `AGENTS.md` attachments
3. 去重
4. compact 后状态重置

### 7.4 message insertion

新增 synthetic user message 注入路径：

1. 由 `SessionInteractionService` 或 `RunLoop` 在 build request 前调用
2. 注入内容存为 `runtime_context` part

优先级：

1. 在当前轮真实用户消息之前
2. 在最近 assistant/tool-result 边界之后

### 7.5 tools

修改 `packages/agent/src/context/tool-registry.ts`：

1. 移除 `planAllowedTools`
2. 移除 `isToolAllowedInVariant()`
3. `enabled = override ?? true`
4. build-specific `task_update` schema 特判保留

同时在各工具执行层补 hard policy：

1. `bash`
2. `apply_patch`
3. `write`
4. `edit`
5. `plan_exit`

### 7.6 plan service and file policy

修改：

1. `apps/server/src/services/session/plan-service.ts`
2. `apps/server/src/services/session/plan-file-service.ts`
3. `packages/agent/src/tools/shared/plan-file-policy.ts`

核心调整：

1. current plan record 可存在而 plan file 可不存在
2. 不再自动生成模板文件
3. `edit` 对不存在 plan file 报错
4. `write` 第一次创建 plan file 合法
5. `plan_exit` 要求当前 plan file 已存在且非空

## 8. 迁移与兼容性

### 8.1 对前端的影响

前端需要新增或调整：

1. 计划模式切换时，不再依赖“预先已有 plan file”
2. plan UI 允许显示“当前还没有形成 plan file”
3. 若用户在 plan mode 但还未写 plan file，TaskBoard/DetailPane 应显示空态而不是本地模板

### 8.2 对已有 session 的影响

旧 session 兼容策略：

1. 旧 session 仍可继续读取已有 current plan
2. 若 current plan 对应文件不存在，不自动补模板
3. 下一次模型在 plan mode 中可自行创建

### 8.3 对缓存命中率的预期影响

预期正向影响：

1. tool schema 不再因 mode 切换而变化
2. system 前缀显著稳定
3. 动态目录记忆不再污染 system 前缀

仍然保留的变化：

1. `userSystem`
2. `format.schema`
3. 当前轮 runtime attachments

这部分变化是合理且必要的。

## 9. 测试与验证

需要新增的验证覆盖：

### 9.1 system 组装

1. `plan -> build` 切换时，system 中不再含 `plan file path`
2. `workspaceRoot/agentName/modelId` 不再进入 system
3. root `AGENTS.md` 仍然进入 system

### 9.2 tools

1. `plan/build` 两种模式下，模型可见 tool list 相同
2. `plan` 模式调用 `bash/apply_patch` 会被 runtime 拒绝
3. `plan` 模式调用 `write/edit` 时，只有 current plan file 被允许
4. `build` 模式调用 `plan_exit` 直接失败

### 9.3 plan file lifecycle

1. 进入 `plan` 模式后，不自动产生空 plan file
2. 模型第一次 `write` 当前 plan file 时成功创建
3. 不存在文件时 `edit` 失败
4. `plan_exit` 在 plan file 不存在或为空时失败

### 9.4 nested AGENTS

1. read 某个深路径文件后，会注入从 workspace root 到目标目录链上的 `AGENTS.md`
2. 已注入过的路径不会重复注入
3. compact 后再次 read 同一路径，会重新注入
4. root `AGENTS.md` 不会同时出现在 system 和 nested attachment 两次

### 9.5 attachment placement

1. runtime attachments 会位于最近 assistant/tool-result 边界之后
2. 当前轮真实 user prompt 保持在 user-side 尾部
3. attachment 不会打断 tool result pairing

## 10. 风险与权衡

### 10.1 风险：模型看到全量工具后，可能更频繁尝试禁用工具

这是已知权衡。

缓解方式：

1. 在 mode rules 中明确禁止行为
2. 在工具执行时给出稳定、明确、可恢复的错误信息
3. 在 plan mode 强提示“只允许规划 artifact 写入”

### 10.2 风险：从 system 挪到 message 后，某些提示权重下降

这是故意权衡。

因为被挪走的那部分本来就不该都是 system 级约束。

对于真正必须高优先级生效的规则，本 RFC 保留它们在 system：

1. variant behavior rules
2. userSystem
3. format.schema

### 10.3 风险：目录级 AGENTS 动态注入会增加 message 噪声

缓解方式：

1. 首版只由 `read` 触发
2. 沿路径链去重
3. compact 后清理并懒恢复

## 11. 方案比较

### 方案 A：维持当前模式，继续按 variant 切 tool list

优点：

1. 改动小
2. 行为直观

缺点：

1. 最伤缓存
2. tool schema 每次 mode 切换都抖
3. 无法自然对齐 `claude-code` 的动态上下文分层

不采用。

### 方案 B：把所有动态信息都继续留在 system，只是顺序调整

优点：

1. 实现简单
2. 不需要 attachment 机制

缺点：

1. 仍然污染 system 前缀
2. plan/build 切换仍会打断大段历史缓存
3. 子目录 `AGENTS.md` 无法按路径懒注入

不采用。

### 方案 C：稳定 tool/system 前缀，动态上下文 attachment 化

优点：

1. 最符合当前 OpenAI 路径的缓存优化目标
2. 最贴近 `claude-code` 的高波动上下文处理方式
3. 有利于未来继续引入 path-triggered context

缺点：

1. 需要新增 runtime attachment 层
2. 需要为 message 插入和重排补一层机制

本 RFC 采用。

## 12. 实施顺序

建议实施顺序如下：

1. 重构 `system-context.ts`，先把高波动 environment/runtime 信息从 system 拿掉
2. 重构 `tool-registry.ts`，让 tool list 稳定
3. 在工具执行层补 `plan/build` hard policy
4. 调整 plan file 生命周期，不再自动创建模板
5. 新增 runtime attachment service
6. 落地 root/system + nested/message 的双层 `AGENTS.md` 注入
7. 最后补 attachment placement 与 compact cleanup

## 13. 开放问题

1. 首版 `task_create` 在 build 模式是否仍然保留可见且可执行？
   当前 RFC 倾向于保留，但由 prompt 降低建议强度。
2. 首版 attachment 是否直接落为新的 `runtime_context` part，还是临时复用 `summary`？
   当前 RFC 明确推荐新增 `runtime_context`，避免语义污染。
3. `glob/grep` 是否也应该触发 nested `AGENTS.md`？
   当前 RFC 首版建议只做 `read`，后续再观察噪声和收益。

## 14. 最终决策摘要

本 RFC 的最终方案如下：

1. `plan/build` 不再切换模型可见工具集合，工具默认全量稳定暴露。
2. `plan/build` 的真正约束由 prompt 和 runtime hard policy 实现。
3. system 中只保留稳定且确实系统级的约束；高波动运行时上下文迁移到 attachment/message。
4. plan file 不再由 runtime 预先生成空模板，而由模型在真正形成计划时显式创建。
5. workspace 根级 `AGENTS.md` 继续走 system memory。
6. 子目录 `AGENTS.md` 采用 read-triggered、沿路径链动态注入，并走 attachment/message 通道。
7. compact 后重建基础 memory，目录级记忆按路径懒恢复。
