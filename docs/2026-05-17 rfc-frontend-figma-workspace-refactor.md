# RFC: 基于 Figma `mycoding` 的工作台前端重构

Status: Proposed

Owner: OpenCode

Last Updated: 2026-05-17

Audience: 人类维护者、coding agent

## 1. 背景

当前项目的后端主链路已经基本可用：

1. `workspace / session / message / task / approval / event` 已有真实 DTO 和持久化。
2. 前端已经能通过 `apps/web/src/lib/api.ts` 拉取真实数据。
3. `apps/web/src/hooks/use-session-stream.ts` 已通过 SSE 刷新消息和任务状态。
4. `apps/server/src/services/agent/interaction-service.ts`、`apps/server/src/services/session/plan-service.ts` 已经能驱动真实 session、plan、task、approval 生命周期。

但当前前端工作台仍然停留在原型阶段：

1. 页面是浅色 dashboard，不像 coding agent console。
2. `TaskBoard`、`MessageList`、`TimelinePanel`、`ApprovalCenter`、`DetailPane` 被纵向堆叠，主视线混乱。
3. `apps/web/src/lib/session-view.ts` 仍在把真实 DTO 包装成旧原型需要的 mock view model。
4. 对话区还没有贴近普通 coding agent 的简洁体验。

本次重构的输入是一份可访问的 Figma Design 文件：

- fileKey: `SUiPzqiIsGhoFvT0p4dlIz`
- nodeId: `2:4`
- node name: `总框架`

这份设计稿虽然是低保真草图，但给出了足够明确的工作台方向：

1. 左栏 `session列表`
2. 中栏 `对话区`
3. 右栏 `task区`

本 RFC 的目标，是把当前前端收敛成一个更接近普通 coding agent 的三栏 console，同时遵守以下产品边界：

1. 不做常驻 `TimelinePanel`
2. 不做右侧 `DetailPane`
3. 不在前端提供文件树、文件内容、stdout/stderr、artifact 等独立可见详情区
4. 对话中只保留用户消息、agent 消息，以及必要的工具摘要
5. 如果 agent 调用了 `edit / write / apply_patch`，则在对话中直接展示 `+/-` diff

## 2. 设计输入

### 2.1 Figma 结构拆解

Figma 节点 `2:4` 的主结构如下：

| 区域         | Node   | 尺寸          | 说明                |
| ------------ | ------ | ------------- | ------------------- |
| 总框架       | `2:4`  | `1209 x 1029` | 三栏布局容器        |
| session 列表 | `2:5`  | `370 x 1029`  | 左侧导航栏          |
| 路径名       | `2:6`  | `370 x 136`   | 左栏顶部信息区      |
| 新增 session | `2:8`  | `370 x 75`    | 左栏 CTA 区         |
| session list | `2:10` | `370 x 231`   | 左栏 session 行列表 |
| 对话区       | `2:13` | `433 x 1029`  | 中栏聊天主区        |
| 对话框       | `2:14` | `433 x 772`   | 中栏消息滚动区      |
| 输入区       | `2:20` | `433 x 257`   | 中栏底部输入区      |
| task 区      | `2:24` | `406 x 1029`  | 右栏任务列表        |

从截图和 MCP 生成代码可归纳出以下设计特征：

1. 整体是深色、低饱和、少装饰的 console。
2. 顶部没有独立 hero/header，所有功能都进入同一块工作画布。
3. 左中右三栏都铺满页面高度，没有“多个独立卡片拼盘”的感觉。
4. 中栏是唯一明显的主操作区，输入区固定在底部。
5. 右栏是 task，不是 detail。

### 2.2 设计稿到产品语义的映射

这份设计稿是低保真草图，里面很多元素只是占位：

1. 左栏顶部的 `路径` 应承载 `workspace 名称 / rootPath / 连接状态 / 模型信息`。
2. 中栏顶部的 `agent / user` 占位，表达的是“简洁对话流”，不是复杂时间线。
3. 右栏的 `task:title / task:concent` 只是任务卡骨架，真实 UI 必须承载 `title / status / summary / approval / error / current task`。
4. 输入区中的 `plan/build切换` 明确说明模式切换要靠近输入框。

因此，“严格按 design 文件来”在本项目中的准确含义是：

1. 严格遵守三栏结构、比例、层级与整体气质。
2. 中栏收敛为接近普通 coding agent 的消息流。
3. 右栏固定为任务，不再塞入详情面板。
4. 允许把工具 diff 作为消息内容内联展示，这是合理增强，不是偏离设计。

## 3. 当前实现审视

### 3.1 当前前端页面结构

`apps/web/src/router.tsx` 当前的 workspace 页结构是：

1. 页面顶部一块全局 workspace header。
2. 左栏 `SessionList`。
3. 中栏按顺序堆叠：
   - `TaskBoard`
   - `MessageList`
   - `Composer`
   - `TimelinePanel`
   - `ApprovalCenter`
4. 右栏 `DetailPane`

这个结构的问题不是“功能太少”，而是“主视图过于复杂”：

1. `TaskBoard` 被放在消息区上方，任务和对话争抢主视线。
2. `TimelinePanel` 独占一整块，但你的产品并不需要常驻 timeline。
3. `ApprovalCenter` 独占一整块，但你更想要接近普通 coding agent 的体验。
4. `DetailPane` 常驻右栏，但你已经明确右栏要换成任务。

### 3.2 当前哪些是“真实的”，哪些还是过渡层

真实能力已经具备：

1. `listSessions / createSession / getSession / listMessages / getSessionPlanBoard / getSessionPlanFile / resumeSession`
2. `submitSessionMessage / manualCompact / cancelCurrentRun`
3. SSE 事件流 `message.* / tool.* / approval.* / run.* / session.*`
4. `SessionPlanBoardDto`、`ResumeSessionDto`、`MessageDto`、`ApprovalDto`、`TaskDto`

仍然明显偏原型的部分：

1. `apps/web/src/lib/session-view.ts`
   - 仍在构造 `MockDetailPane`
   - 仍在使用 `sampleSessions`
   - 仍在输出 mock 风格摘要
2. `apps/web/src/features/details/detail-pane.tsx`
   - 以 mock pane 为中心
   - 与当前产品边界不一致
3. `apps/web/src/features/chat/timeline-panel.tsx`
   - 与当前产品边界不一致
4. `apps/web/src/features/approvals/approval-center.tsx`
   - 信息密度和视觉层级偏“后台审批中心”
   - 不符合“普通 coding agent”体验

### 3.3 当前工具 diff 数据现状

你要的核心增强是：

1. agent 调用 `edit / write / apply_patch` 后
2. 在对话里直接看到 `+/-` diff

当前代码现状是：

1. `apply_patch`
   - 已经生成 unified diff
   - diff 已存入 tool part 的 `metadata.diff` / `payload.diff`
   - 前端可以直接渲染
2. `edit`
   - 当前只保存 `diagnostics / filePath / matches / replaceAll / snapshotArtifactId`
   - 没有把 diff 持久化到 tool part
3. `write`
   - 当前只保存 `bytesWritten / diagnostics / filePath / exists / snapshotArtifactId`
   - 没有把 diff 持久化到 tool part

因此要实现统一的“对话内联 diff”，除了前端改造，还需要补一个很小的 runtime 变更：

1. `edit` 工具执行后持久化 unified diff
2. `write` 工具执行后持久化 unified diff
3. `apply_patch` 继续沿用现有 diff 字段

## 4. 重构目标

### 4.1 产品目标

新的工作台必须满足：

1. 桌面端回到 Figma 三栏结构。
2. 左栏只负责 session 导航和创建。
3. 中栏只保留用户消息、agent 消息、简洁工具反馈和输入区。
4. 右栏固定展示任务列表，不再做详情。
5. 不做常驻 timeline，不做常驻 approval center，不做常驻 detail pane。
6. `edit / write / apply_patch` 的 diff 直接在对话中展示。

### 4.2 工程目标

新的实现必须满足：

1. 删除 workspace 页面对 `sampleSessions` 和 `MockDetailPane` 的依赖。
2. 把 `session-view.ts` 的 mock 适配逻辑替换为更薄的真实 projection/selectors。
3. `MessageList` 直接消费真实 `MessageDto.content`，并支持工具 diff 内联展示。
4. `TaskBoard` 直接消费真实 `SessionPlanBoardDto`。
5. 尽量少动 server，但要补 `edit / write` 的 diff 持久化。

## 5. 核心判断

### 5.1 右栏必须改成 task rail

设计稿最明确的信号就是右栏属于任务，而不是详情。当前常驻 `DetailPane` 必须退出主舞台。

推荐改法：

1. 右栏常驻 `TaskRail`
2. 展示当前 plan 下的任务顺序、状态、摘要、待审批、失败提示
3. 不在右栏再提供文件、diff、stdout、artifact tabs

### 5.2 中栏只保留“对话 + 工具摘要”

你的产品意图不是做一个可视化调试后台，而是一个更像普通 coding agent 的对话工作台。

因此中栏应收敛为：

1. 用户消息
2. agent 消息
3. tool part
4. 内联审批动作
5. diff block
6. 输入框

不再常驻：

1. `TimelinePanel`
2. `ApprovalCenter`
3. `DetailPane`

### 5.3 diff 不做独立 inspector，而做消息内联块

这次不应该引入大而全的 inspector model。

更合理的实现是：

1. 对话中的 tool part 如果带 diff，则在该消息下直接显示 diff block
2. diff block 支持折叠/展开
3. 仅服务于 `edit / write / apply_patch`

这样既满足你要的 `+/-` 体验，也不会让 UI 再复杂化。

### 5.4 `session-view.ts` 这层 mock adapter 必须替换

当前 `session-view.ts` 的问题不在于“有一层 projection”，而在于它还是原型时代的 projection。

它现在仍然：

1. 依赖 `sampleSessions`
2. 输出 `MockDetailPane`
3. 拼接演示型摘要

这会直接拖累后续重构。

推荐改法：

1. 保留 projection 思路
2. 但把它改成只基于真实 DTO 的轻量 selector
3. 只生成三栏工作台真正需要的最小展示字段

## 6. 目标信息架构

### 6.1 顶层布局

桌面端采用三栏固定画布：

1. 左栏 `WorkspaceRail`
2. 中栏 `ConversationColumn`
3. 右栏 `TaskRail`

推荐桌面比例：

1. 左栏宽度 `clamp(320px, 30vw, 370px)`
2. 中栏宽度 `minmax(420px, 1fr)`
3. 右栏宽度 `clamp(320px, 33vw, 406px)`

视觉规则：

1. 页面整体背景为深色
2. 三栏使用接近但略有区分的深灰层级
3. 不再使用大量白底大卡片

### 6.2 左栏 `WorkspaceRail`

左栏承载：

1. `workspace.name`
2. `workspace.rootPath`
3. `MODEL_LABEL`
4. `SSE status`
5. 新建 session 入口
6. session 列表

设计约束：

1. session 行更像导航列表，而不是大块业务卡
2. 新建 session 表单默认折叠
3. 左栏不承担消息、任务之外的复杂信息

### 6.3 中栏 `ConversationColumn`

中栏是新的核心舞台，承担：

1. 用户消息
2. agent 消息
3. tool 执行反馈
4. approval action
5. diff block
6. 输入区

结构建议：

1. `ConversationScrollArea`
   - user message
   - assistant message
   - reasoning part
   - tool part
   - diff block
2. `ComposerDock`
   - 大输入框
   - `plan / build` segmented control
   - 发送按钮
   - 当前状态 hint

消息渲染原则：

1. 用户消息靠右或右对齐
2. assistant / tool 信息靠左
3. 不给每条消息包厚重白色大卡片
4. 除 diff 外，不在中栏引入复杂 inspector 行为

### 6.4 右栏 `TaskRail`

右栏承接 `SessionPlanBoardDto` 的真实内容。

结构建议：

1. 顶部 `TaskRailHeader`
   - session title
   - session status
2. 中部 `TaskList`
   - 按 `position` 排序
   - 当前任务高亮
   - `status`
   - `summaryText`
   - `lastErrorText`
   - `pending approval count`
3. 底部可选 `PlanSummary`
   - 仅展示简短 plan 摘要
   - 不展开成详情面板

任务卡片规则：

1. 使用紧凑深色卡片或浅灰卡片
2. `acceptanceCriteria` 默认折叠或不显示
3. 错误和审批是辅助信息，不压过标题
4. 任务列表是导航性信息，不是详情容器

## 7. 视觉系统方案

### 7.1 设计基调

当前 `apps/web/src/styles.css` 和 `tailwind.config.ts` 采用的是偏暖、浅色、半透明的 UI 方向。这与 Figma 稿不一致。

建议这次重构引入一套新的 console token：

```css
:root {
  --console-bg: #1f1f1f;
  --console-rail: #2e2e2e;
  --console-panel: #242424;
  --console-elevated: #313131;
  --console-text: #f3f3f3;
  --console-muted: #a1a1a1;
  --console-line: #101010;
  --console-warning: #d6a34a;
  --console-danger: #c96a6a;
  --console-success: #74b47b;
}
```

约束：

1. 整体以黑灰为主
2. 状态色只能点到为止
3. 不再使用当前 `mist / sand / ember` 作为主背景层

### 7.2 字体策略

设计稿 MCP 默认推断了 `Inter`，但仓库既有字体是 `Space Grotesk` 和 `IBM Plex Sans`。

推荐做法：

1. 保留 `IBM Plex Sans` 作为正文
2. 仅在少量标题上使用 `Space Grotesk`
3. 不新增更多字体依赖

### 7.3 间距和圆角

建议对齐设计稿的“偏方、少糖衣”方向：

1. 页面主容器圆角缩小到 `0` 或 `16px`
2. session row / task row 圆角优先 `10px ~ 16px`
3. 输入框保持 `16px` 左右圆角
4. 区块间距尽量收紧

## 8. 数据与交互映射

### 8.1 左栏数据来源

左栏直接复用：

1. `listWorkspaces`
2. `listSessions`
3. `createSession`

展示映射：

1. `workspace.name` -> 主标题
2. `workspace.rootPath` -> 副标题
3. `session.title` -> session row 标题
4. `session.updatedAt` -> 最后活跃时间
5. `session.status` -> 小状态点或小 badge

### 8.2 中栏数据来源

中栏直接复用：

1. `listMessages`
2. `submitSessionMessage`
3. `manualCompact`
4. `cancelCurrentRun`
5. `resumeSession`
6. `useSessionStream`

关键改造点：

1. `MessageList` 保留真实 `MessageDto.content` 解析能力
2. 不再把 `buildTimelineItemsFromEvents` 挂成独立面板
3. `pendingApprovals` 与相关 tool / message 内联合并展示
4. `edit / write / apply_patch` 的 diff 在消息内渲染

### 8.3 右栏数据来源

右栏直接复用：

1. `getSessionPlanBoard`
2. `getSessionPlanFile`

展示映射：

1. `tasks` -> 右栏任务列表
2. `currentTask` -> 当前任务高亮
3. `waitingApprovalTaskIds` -> 任务上的审批 badge
4. `session.status` -> 右栏 header 状态
5. `planFile.content` -> 仅用于生成简短摘要，不做详情页

### 8.4 diff 数据来源

需要支持的 diff 来源如下：

1. `apply_patch`
   - 使用现有 `metadata.diff` / `payload.diff`
2. `edit`
   - 新增统一 diff 字段持久化
3. `write`
   - 新增统一 diff 字段持久化

推荐统一字段：

1. `part.state.metadata.diff`
2. `part.state.payload.diff`

这样前端可以用同一套渲染逻辑处理三种工具。

## 9. 组件重构方案

### 9.1 建议新增的组件边界

建议新增或重组为以下模块：

1. `features/workspace-console/console-shell.tsx`
2. `features/workspace-console/workspace-rail.tsx`
3. `features/workspace-console/session-list-compact.tsx`
4. `features/workspace-console/conversation-column.tsx`
5. `features/workspace-console/task-rail.tsx`
6. `features/workspace-console/use-workspace-console-model.ts`
7. `features/chat/tool-diff-block.tsx`

### 9.2 现有组件的去留

建议保留并重写样式/职责：

1. `SessionList`
2. `MessageList`
3. `Composer`
4. `TaskBoard`

建议删除或退出主路径：

1. `TimelinePanel`
2. `ApprovalCenter`
3. `DetailPane`
4. `FilePreview`

建议删除或显著收缩：

1. `apps/web/src/lib/session-view.ts` 中的 mock 组装
2. `sampleSessions` 驱动的视图依赖

### 9.3 路由层重构

`apps/web/src/router.tsx` 应做这些调整：

1. 去掉 workspace 页顶部大 header
2. 不再在中栏纵向堆 `TaskBoard + MessageList + TimelinePanel + ApprovalCenter`
3. 改为一次性渲染 `WorkspaceRail + ConversationColumn + TaskRail`
4. 保留现有 query/mutation/SSE 组织方式，但把投影逻辑移入 `useWorkspaceConsoleModel`

## 10. 需要的最小 runtime / server 改动

### 10.1 `edit` 工具补 diff 持久化

在 `packages/agent/src/tools/edit/index.ts` 中：

1. 基于编辑前后的文本生成 unified diff
2. 将 diff 写入 `metadata.diff`
3. 将 diff 同步写入 `payload.diff`

推荐复用：

1. `packages/agent/src/tools/diff.ts`
2. `createUnifiedDiff()` 或 `createFileDiff()`

### 10.2 `write` 工具补 diff 持久化

在 `packages/agent/src/tools/write/index.ts` 中：

1. 如果文件原本存在，则基于旧内容和新内容生成 unified diff
2. 如果文件原本不存在，则生成 create-file 语义的 diff
3. 将 diff 写入 `metadata.diff`
4. 将 diff 同步写入 `payload.diff`

### 10.3 `apply_patch` 维持现有字段

`apply_patch` 当前已经输出 diff，保留现状即可。

前端只需要统一消费字段，不需要额外新增后端接口。

## 11. 分阶段实施

### Phase 1: 结构重排与主题替换

目标：

1. 先把页面从浅色 dashboard 改成深色三栏 console
2. 去掉顶部 hero 和右侧 detail pane

范围：

1. 改写 `router.tsx` 的工作台布局
2. 改写 `SessionList`、`MessageList`、`Composer`、`TaskBoard` 样式
3. 用右栏 `TaskRail` 取代当前 `DetailPane`

验收：

1. 页面第一眼接近 Figma 稿的三栏结构
2. 能正常切换 session、收发消息、看到任务列表

### Phase 2: 对话简化与内联审批

目标：

1. 中栏只保留普通 coding agent 风格的消息流
2. 审批不再有独立大面板

范围：

1. 去掉 `TimelinePanel`
2. 去掉 `ApprovalCenter` 常驻展示
3. 把 pending approval 融入消息流和任务 badge

验收：

1. 中栏只剩消息、工具反馈、审批 action 和输入区
2. 用户不需要跳到独立审批中心

### Phase 3: 工具 diff 内联展示

目标：

1. `apply_patch / edit / write` 都能在对话中显示 `+/-` diff

范围：

1. runtime 补 `edit / write` diff 持久化
2. `MessageList` 新增 `ToolDiffBlock`
3. diff 默认折叠，可展开

验收：

1. 三种写文件相关工具都能显示 unified diff
2. 不需要依赖右侧详情页即可理解改了什么

### Phase 4: 删除历史原型残留

目标：

1. 清理当前 prototype 依赖和 mock 结构

范围：

1. 删除对 `sampleSessions` 的依赖
2. 删除 `MockDetailPane` 风格适配
3. 收缩或替换 `session-view.ts`

验收：

1. workspace 主路径不再依赖 mock 数据
2. 真实 DTO 成为工作台唯一状态来源

## 12. 验收标准

重构完成后，至少满足以下条件：

1. `apps/web` 的 workspace 主界面不再是浅色 dashboard
2. 桌面端默认工作台为三栏 dark console
3. 右栏展示真实 tasks，而不是常驻 `DetailPane`
4. 中栏保留 `plan / build` 切换和简洁对话流
5. 不再有常驻 `TimelinePanel`
6. 不再有常驻 `ApprovalCenter`
7. `edit / write / apply_patch` 的 diff 能在对话里直接显示
8. workspace 主界面不再依赖 `sampleSessions` 和 `MockDetailPane`

## 13. 推荐的实现顺序

推荐按下面顺序开发：

1. 先改布局和主题，确保三栏骨架正确
2. 再删掉 timeline / detail / approval 的常驻路径
3. 再补 `edit / write` diff 持久化
4. 最后把 diff block 接到对话里，并清理 mock adapter

这个顺序的好处是：

1. 风险低
2. 每一步都可见
3. 不需要先补很多新接口
4. 始终围绕“简化主视图”和“把 diff 放进消息流”这两个核心目标推进

## 14. 最终判断

当前项目前后端主链路已经足够支撑一次真正的工作台重构，问题不在“功能不够”，而在“前端视图还是原型思维”。

这次重构的核心不是加更多面板，而是删掉多余面板，只保留三件事：

1. 左边看 session
2. 中间看用户和 agent 对话
3. 右边看 task

以及唯一一个必要增强：

1. 当 agent 调用 `edit / write / apply_patch` 时，在对话里直接给出 `+/-` diff

只要坚持这个边界，前端就会从“复杂原型台”回到“可用的 coding agent console”。
