import type { SessionDto, WorkspaceDto } from '@opencode/shared';

export type MockTaskStatus =
  | 'draft'
  | 'todo'
  | 'running'
  | 'blocked'
  | 'done'
  | 'failed';

export type MockTask = {
  acceptance: string;
  description: string;
  evidenceSummary?: string;
  id: string;
  pendingApproval?: number;
  status: MockTaskStatus;
  summary: string;
  title: string;
};

export type MockTimelineItem = {
  description: string;
  id: string;
  label: string;
  sortKey?: string;
  status: 'info' | 'active' | 'success' | 'warning' | 'error';
  time: string;
  title: string;
  type:
    | 'goal'
    | 'plan'
    | 'task'
    | 'message'
    | 'tool'
    | 'approval'
    | 'result'
    | 'error';
};

export type MockFileNode = {
  children?: MockFileNode[];
  name: string;
  path: string;
  type: 'directory' | 'file';
};

export type MockPendingApproval = {
  kind: '写文件审批' | '命令审批';
  risk: string;
  summary: string;
  title: string;
};

export type MockDetailPane = {
  activeTab: '文件' | 'Diff' | '输出' | '错误' | '产物';
  content: string;
  contentTitle: string;
  fileTree: MockFileNode[];
  metadata: Array<{ label: string; value: string }>;
  pendingApproval?: MockPendingApproval;
  selectedPath: string;
  subtitle: string;
  title: string;
};

export type MockSessionView = SessionDto & {
  composerHint: string;
  composerValue: string;
  detailPane: MockDetailPane;
  goal: string;
  mode: 'planning' | 'executing';
  pendingApprovals: number;
  plannerNotes: string[];
  progressLabel: string;
  summary: string;
  tasks: MockTask[];
  timeline: MockTimelineItem[];
};

export const sampleWorkspace: WorkspaceDto & { model: string } = {
  createdAt: '2026-03-29 10:30',
  id: 'local-demo',
  lastOpenedAt: '2026-03-29 10:30',
  model: 'gpt-4.1-mini',
  name: 'OpenCode Web Lite',
  rootPath: '/Users/demo/opencode-lite',
  updatedAt: '2026-03-29 10:30'
};

const sampleTree: MockFileNode[] = [
  {
    children: [
      {
        children: [
          {
            name: '任务工作台.tsx',
            path: 'apps/web/src/features/tasks/任务工作台.tsx',
            type: 'file'
          },
          {
            name: '执行时间线.tsx',
            path: 'apps/web/src/features/tasks/执行时间线.tsx',
            type: 'file'
          }
        ],
        name: 'tasks',
        path: 'apps/web/src/features/tasks',
        type: 'directory'
      },
      {
        children: [
          {
            name: '详情面板.tsx',
            path: 'apps/web/src/features/details/详情面板.tsx',
            type: 'file'
          }
        ],
        name: 'details',
        path: 'apps/web/src/features/details',
        type: 'directory'
      }
    ],
    name: 'apps',
    path: 'apps',
    type: 'directory'
  },
  {
    name: 'docs/opencode-web-lite-mvp.md',
    path: 'docs/opencode-web-lite-mvp.md',
    type: 'file'
  },
  {
    name: 'package.json',
    path: 'package.json',
    type: 'file'
  }
];

export const sampleSessions: MockSessionView[] = [
  {
    composerHint: '规划阶段先确认任务拆解，再进入执行。',
    composerValue: '把第 3 个小任务拆得更细一点，并明确验收标准。',
    createdAt: '2026-03-29 09:12',
    goalText:
      '把 OpenCode Web Lite 的主工作台改成“复杂任务 -> 小任务 -> 时间线 -> 详情区”的结构，并弱化重型审批中心。',
    detailPane: {
      activeTab: '产物',
      content: `规划摘要

1. 先把工作台重心从聊天流转成任务工作台。
2. 首版只保留单层任务，不做依赖图和多级树。
3. 右侧详情区统一承载文件、Diff、输出和审批信息。

待确认点

- 是否保留单独的审批卡片
- 规划确认后是否允许局部重生成`,
      contentTitle: '规划说明',
      fileTree: sampleTree,
      metadata: [
        { label: '当前阶段', value: '规划中' },
        { label: '草稿任务', value: '5 个' },
        { label: '待决策', value: '2 项' }
      ],
      selectedPath: 'docs/opencode-web-lite-mvp.md',
      subtitle: '先确认拆解方式，再让 agent 进入执行。',
      title: '规划详情'
    },
    defaultVariant: 'plan',
    goal: '把 OpenCode Web Lite 的主工作台改成“复杂任务 -> 小任务 -> 时间线 -> 详情区”的结构，并弱化重型审批中心。',
    id: 'session-001',
    mode: 'planning',
    pendingApprovals: 0,
    plannerNotes: [
      '先把主对象从消息切换成任务，不要直接在聊天流里塞更多卡片。',
      '首版只做一级小任务，降低认知负担和实现复杂度。',
      '规划确认后不跳页，直接把同一区域切换为执行态。'
    ],
    progressLabel: '等待确认计划',
    status: 'planning',
    summary: '正在审核复杂任务拆解，尚未开始执行。',
    tasks: [
      {
        acceptance: '明确中间列上半区是任务板，下半区是执行时间线。',
        description: '重新定义主工作台信息层次，避免聊天区继续成为唯一主视图。',
        id: 'task-plan-1',
        status: 'draft',
        summary: '任务结构重构',
        title: '确定页面主骨架'
      },
      {
        acceptance: '规划态里能展示 goal、任务草稿、验收标准和确认入口。',
        description: '新建复杂任务后先进入规划态，允许用户审核和调整拆解。',
        id: 'task-plan-2',
        status: 'draft',
        summary: '规划阶段设计',
        title: '设计规划中界面'
      },
      {
        acceptance: '确认后同页切换，不更换路由和核心布局。',
        description: '规划确认后将同一区域收缩成执行态任务板，保证上下文连续。',
        id: 'task-plan-3',
        status: 'draft',
        summary: '平滑过渡',
        title: '定义规划到执行的过渡'
      },
      {
        acceptance: '右侧详情区能统一承接文件、Diff、输出和错误。',
        description:
          '避免小任务和证据视图混放在一起，让右侧只承担“当前选中对象的详情”。',
        id: 'task-plan-4',
        status: 'draft',
        summary: '详情区职责收口',
        title: '收敛右侧详情面板'
      },
      {
        acceptance: '审批只在高风险动作出现时展示，不再占主舞台。',
        description: '保留审批能力，但将其放入任务上下文和详情区中。',
        id: 'task-plan-5',
        status: 'draft',
        summary: '审批降级为护栏',
        title: '弱化审批中心'
      }
    ],
    timeline: [
      {
        description: '用户提交了关于复杂任务页的页面结构需求。',
        id: 'timeline-plan-1',
        label: '目标',
        status: 'info',
        time: '09:12',
        title: '收到复杂任务目标',
        type: 'goal'
      },
      {
        description: 'agent 先给出 5 个一级小任务，等待你审核是否合理。',
        id: 'timeline-plan-2',
        label: '规划',
        status: 'active',
        time: '09:14',
        title: '生成任务拆解草稿',
        type: 'plan'
      },
      {
        description: '当前停留在“规划确认前”，尚未进入真实执行。',
        id: 'timeline-plan-3',
        label: '状态',
        status: 'warning',
        time: '09:15',
        title: '等待确认计划',
        type: 'task'
      }
    ],
    title: '重构复杂任务工作台',
    updatedAt: '2026-03-29 09:15',
    workspaceId: sampleWorkspace.id
  },
  {
    composerHint: '执行阶段可以补充约束，或要求重试当前任务。',
    composerValue: '先别继续改文档，先把中间列任务板的视觉层级做清楚。',
    createdAt: '2026-03-29 10:02',
    goalText:
      '把新的复杂任务工作台真实渲染出来，包括左侧复杂任务列表、中间任务板与执行时间线、右侧详情区。',
    detailPane: {
      activeTab: 'Diff',
      content: `diff --git a/apps/web/src/router.tsx b/apps/web/src/router.tsx
@@
- <TimelinePanel events={sampleTimeline} />
- <ApprovalCenter approvals={sampleApprovals} />
+ <TaskBoard session={currentSession} />
+ <TimelinePanel items={currentSession.timeline} />
+ <DetailPane data={currentSession.detailPane} />

@@
- <FileExplorer tree={sampleTree} />
- <FilePreview />
+ <DetailPane data={currentSession.detailPane} />`,
      contentTitle: 'apps/web/src/router.tsx',
      fileTree: sampleTree,
      metadata: [
        { label: '当前任务', value: '实现中' },
        { label: '已完成', value: '1 / 5' },
        { label: '待审批', value: '1 个' }
      ],
      pendingApproval: {
        kind: '写文件审批',
        risk: '中风险',
        summary: '准备替换任务页布局骨架，并新增任务板与详情区组件。',
        title: '修改 apps/web/src/router.tsx'
      },
      selectedPath: 'apps/web/src/router.tsx',
      subtitle: '当前聚焦于布局切换和任务板视觉层级。',
      title: '实现详情'
    },
    defaultVariant: 'build',
    goal: '把新的复杂任务工作台真实渲染出来，包括左侧复杂任务列表、中间任务板与执行时间线、右侧详情区。',
    id: 'session-002',
    mode: 'executing',
    pendingApprovals: 1,
    plannerNotes: [
      '规划已确认，当前在按顺序执行第 2 个子任务。',
      '高风险改动只在上下文中展示审批，不单独占据主栏。'
    ],
    progressLabel: '正在执行第 2 / 5 个任务',
    status: 'waiting_approval',
    summary: '已完成页面骨架梳理，正在实现任务板和时间线联动。',
    tasks: [
      {
        acceptance: '复杂任务列表、任务板、详情区三栏结构已经稳定。',
        description: '把页面信息层次重构为稳定的三栏布局。',
        evidenceSummary: '已完成布局草图和 mock 结构映射。',
        id: 'task-run-1',
        status: 'done',
        summary: '页面骨架已调整',
        title: '重建三栏布局'
      },
      {
        acceptance: '任务板能清楚区分当前任务、已完成任务和待做任务。',
        description: '实现中间列上半区的任务板，让复杂任务执行状态持续可见。',
        evidenceSummary: '已有 2 个任务卡在页面中渲染，当前继续打磨样式。',
        id: 'task-run-2',
        pendingApproval: 1,
        status: 'running',
        summary: '正在细化任务板样式',
        title: '实现任务板'
      },
      {
        acceptance: '执行时间线能显示关键事件，并与右侧详情联动。',
        description: '保留聊天叙述，但将其降级为执行时间线的一部分。',
        id: 'task-run-3',
        status: 'todo',
        summary: '等待前序完成',
        title: '接入执行时间线'
      },
      {
        acceptance: '右侧可以切换文件、Diff、输出和产物。',
        description: '把原先分散的文件预览和审批卡片收敛到统一详情面板中。',
        id: 'task-run-4',
        status: 'todo',
        summary: '尚未开始',
        title: '重做详情面板'
      },
      {
        acceptance: '确认规划态与执行态切换逻辑自然且不跳页。',
        description: '检查同一路由下不同模式是否足够自然。',
        id: 'task-run-5',
        status: 'blocked',
        summary: '等待任务板和详情区先稳定',
        title: '验证双状态切换'
      }
    ],
    timeline: [
      {
        description: 'agent 已确认采用三栏布局，不再让聊天区成为唯一主视图。',
        id: 'timeline-run-1',
        label: '任务',
        status: 'success',
        time: '10:05',
        title: '完成页面骨架重构',
        type: 'task'
      },
      {
        description:
          '读取了当前 router 和 mock 数据，准备替换旧的 Timeline + Approval 布局。',
        id: 'timeline-run-2',
        label: '工具',
        status: 'info',
        time: '10:08',
        title: '读取前端骨架文件',
        type: 'tool'
      },
      {
        description:
          '当前正在实现任务板区域，准备将规划态和执行态统一到同一页面中。',
        id: 'timeline-run-3',
        label: '执行',
        status: 'active',
        time: '10:16',
        title: '开始实现任务板',
        type: 'message'
      },
      {
        description:
          '需要替换 `router.tsx` 和新增任务板组件，影响主工作台布局。',
        id: 'timeline-run-4',
        label: '审批',
        status: 'warning',
        time: '10:21',
        title: '等待写文件审批',
        type: 'approval'
      }
    ],
    title: '把新工作台做成可视化原型',
    updatedAt: '2026-03-29 10:21',
    workspaceId: sampleWorkspace.id
  }
];

export const primarySession = sampleSessions[1]!;

export function getMockSession(sessionId: string) {
  return (
    sampleSessions.find((session) => session.id === sessionId) ?? primarySession
  );
}
