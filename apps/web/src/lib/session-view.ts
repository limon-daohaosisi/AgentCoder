import type {
  ResumeSessionDto,
  SessionEventEnvelope,
  SessionDto,
  WorkspaceDto
} from '@opencode/shared';
import type { WorkspaceTreeNodeDto } from './api';
import type {
  MockDetailPane,
  MockFileNode,
  MockTimelineItem,
  MockSessionView
} from './mock-data';
import { sampleSessions } from './mock-data';

function joinTreePath(parentPath: string, name: string) {
  return parentPath.endsWith('/')
    ? `${parentPath}${name}`
    : `${parentPath}/${name}`;
}

function truncateText(value: string, maxLength: number) {
  const normalizedValue = value.trim().replace(/\s+/gu, ' ');

  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatTimestamp(timestamp: string) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit'
  });
}

function createTimelineItem(input: {
  description: string;
  id: string;
  label: string;
  sortKey?: string;
  status: MockTimelineItem['status'];
  time: string;
  title: string;
  type: MockTimelineItem['type'];
}): MockTimelineItem {
  return {
    description: input.description,
    id: input.id,
    label: input.label,
    sortKey: input.sortKey,
    status: input.status,
    time: input.time,
    title: input.title,
    type: input.type
  };
}

type TimelineEntry = {
  item: MockTimelineItem;
  sortKey: string;
};

function createTimelineEntry(
  input: Parameters<typeof createTimelineItem>[0] & { sortKey: string }
): TimelineEntry {
  return {
    item: createTimelineItem(input),
    sortKey: input.sortKey
  };
}

function toTimelineItems(entries: TimelineEntry[]) {
  return entries
    .sort((left, right) =>
      left.sortKey === right.sortKey
        ? left.item.id.localeCompare(right.item.id)
        : left.sortKey.localeCompare(right.sortKey)
    )
    .map((entry) => entry.item);
}

export function buildTimelineItemsFromEvents(events: SessionEventEnvelope[]) {
  const items: TimelineEntry[] = [];

  for (const envelope of events) {
    const time = formatTimestamp(envelope.createdAt);

    switch (envelope.event.type) {
      case 'message.created': {
        const { message } = envelope.event;

        if (message.role !== 'assistant') {
          items.push(
            createTimelineEntry({
              description: '用户消息已提交，agent 即将处理。',
              id: message.id,
              label: 'User',
              status: 'info',
              sortKey: `${envelope.createdAt}:${String(envelope.sequenceNo).padStart(8, '0')}`,
              time,
              title: '用户消息',
              type: 'message'
            })
          );
        }

        break;
      }
      case 'message.completed': {
        items.push(
          createTimelineEntry({
            description: 'Assistant 响应已完成。',
            id: envelope.event.messageId,
            label: 'Assistant',
            status: 'success',
            sortKey: `${envelope.createdAt}:${String(envelope.sequenceNo).padStart(8, '0')}`,
            time,
            title: 'Assistant 响应完成',
            type: 'message'
          })
        );
        break;
      }
      case 'message.cancelled': {
        items.push(
          createTimelineEntry({
            description: '本轮回复已取消',
            id: envelope.event.messageId,
            label: 'Assistant',
            status: 'warning',
            sortKey: `${envelope.createdAt}:${String(envelope.sequenceNo).padStart(8, '0')}`,
            time,
            title: 'Assistant 响应已取消',
            type: 'message'
          })
        );
        break;
      }
      case 'message.part.created':
      case 'message.part.delta':
      case 'message.part.updated':
        break;
      case 'run.created':
        items.push(
          createTimelineEntry({
            description: `Run ${envelope.event.run.id} 已开始`,
            id: envelope.event.run.id,
            label: 'Run',
            status: 'active',
            sortKey: `${envelope.createdAt}:${String(envelope.sequenceNo).padStart(8, '0')}`,
            time,
            title: '新运行已开始',
            type: 'task'
          })
        );
        break;
      case 'run.completed':
        items.push(
          createTimelineEntry({
            description: `Run ${envelope.event.run.id} 已完成`,
            id: envelope.event.run.id,
            label: 'Run',
            status: 'success',
            sortKey: `${envelope.createdAt}:${String(envelope.sequenceNo).padStart(8, '0')}`,
            time,
            title: '运行完成',
            type: 'result'
          })
        );
        break;
      case 'run.cancelled':
        items.push(
          createTimelineEntry({
            description: envelope.event.reason,
            id: envelope.event.run.id,
            label: 'Run',
            status: 'warning',
            sortKey: `${envelope.createdAt}:${String(envelope.sequenceNo).padStart(8, '0')}`,
            time,
            title: '运行已取消',
            type: 'result'
          })
        );
        break;
      case 'run.blocked':
        items.push(
          createTimelineEntry({
            description: envelope.event.error,
            id: envelope.event.run.id,
            label: 'Run',
            status: 'warning',
            sortKey: `${envelope.createdAt}:${String(envelope.sequenceNo).padStart(8, '0')}`,
            time,
            title: '运行已阻塞',
            type: 'result'
          })
        );
        break;
      case 'run.failed':
        items.push(
          createTimelineEntry({
            description: envelope.event.error,
            id: envelope.event.run.id,
            label: 'Run',
            status: 'error',
            sortKey: `${envelope.createdAt}:${String(envelope.sequenceNo).padStart(8, '0')}`,
            time,
            title: '运行失败',
            type: 'error'
          })
        );
        break;
      case 'tool.pending':
        items.push(
          createTimelineEntry({
            description: `等待审批 ${envelope.event.toolCall.toolName}`,
            id: envelope.event.toolCall.id,
            label: 'Approval',
            status: 'warning',
            sortKey: `${envelope.createdAt}:${String(envelope.sequenceNo).padStart(8, '0')}`,
            time,
            title: '工具等待审批',
            type: 'approval'
          })
        );
        break;
      case 'approval.created':
        items.push(
          createTimelineEntry({
            description: `审批类型：${envelope.event.approval.kind}`,
            id: envelope.event.approval.id,
            label: 'Approval',
            status: 'warning',
            sortKey: `${envelope.createdAt}:${String(envelope.sequenceNo).padStart(8, '0')}`,
            time,
            title: '审批已创建',
            type: 'approval'
          })
        );
        break;
      case 'approval.resolved':
        items.push(
          createTimelineEntry({
            description: `审批结果：${envelope.event.decision}`,
            id: envelope.event.approvalId,
            label: 'Approval',
            status:
              envelope.event.decision === 'approved' ? 'success' : 'warning',
            sortKey: `${envelope.createdAt}:${String(envelope.sequenceNo).padStart(8, '0')}`,
            time,
            title: '审批已处理',
            type: 'approval'
          })
        );
        break;
      case 'tool.running':
        items.push(
          createTimelineEntry({
            description: `工具调用 ${envelope.event.toolCallId} 正在执行`,
            id: envelope.event.toolCallId,
            label: 'Tool',
            status: 'active',
            sortKey: `${envelope.createdAt}:${String(envelope.sequenceNo).padStart(8, '0')}`,
            time,
            title: '工具执行中',
            type: 'tool'
          })
        );
        break;
      case 'tool.completed':
        items.push(
          createTimelineEntry({
            description: `工具 ${envelope.event.toolCall.toolName} 已完成`,
            id: envelope.event.toolCall.id,
            label: 'Tool',
            status: 'success',
            sortKey: `${envelope.createdAt}:${String(envelope.sequenceNo).padStart(8, '0')}`,
            time,
            title: '工具执行完成',
            type: 'tool'
          })
        );
        break;
      case 'tool.failed':
        items.push(
          createTimelineEntry({
            description: envelope.event.error,
            id: envelope.event.toolCallId,
            label: 'Tool',
            status: 'error',
            sortKey: `${envelope.createdAt}:${String(envelope.sequenceNo).padStart(8, '0')}`,
            time,
            title: '工具执行失败',
            type: 'error'
          })
        );
        break;
      case 'session.recovered':
        items.push(
          createTimelineEntry({
            description:
              envelope.event.diagnostics?.join('\n') ||
              '启动恢复已收敛旧运行状态',
            id: `${envelope.sequenceNo}`,
            label: 'Session',
            status: 'warning',
            sortKey: `${envelope.createdAt}:${String(envelope.sequenceNo).padStart(8, '0')}`,
            time,
            title: 'Session 已恢复',
            type: 'result'
          })
        );
        break;
      case 'session.resumable':
        items.push(
          createTimelineEntry({
            description: '会话已保存 checkpoint，可在审批后恢复。',
            id: `${envelope.sequenceNo}`,
            label: 'Session',
            status: 'warning',
            sortKey: `${envelope.createdAt}:${String(envelope.sequenceNo).padStart(8, '0')}`,
            time,
            title: 'Session 可恢复',
            type: 'result'
          })
        );
        break;
      case 'session.updated':
        break;
    }
  }

  return toTimelineItems(items);
}

function getSessionMode(status: SessionDto['status']): MockSessionView['mode'] {
  return status === 'planning' ? 'planning' : 'executing';
}

function getSessionProgressLabel(status: SessionDto['status']) {
  switch (status) {
    case 'planning':
      return '等待规划阶段接入';
    case 'idle':
      return '空闲，可继续输入';
    case 'executing':
      return '执行中';
    case 'waiting_approval':
      return '等待审批';
    case 'blocked':
      return '已阻塞';
    case 'completed':
      return '已完成';
    case 'archived':
      return '已归档';
    default:
      return status;
  }
}

function getSessionSummary(session: SessionDto) {
  if (session.lastErrorText) {
    return session.status === 'blocked'
      ? `当前会话被阻塞，需要先恢复后才能继续：${session.lastErrorText}`
      : `上一次运行失败：${session.lastErrorText}。你可以继续输入或重试。`;
  }

  switch (session.status) {
    case 'planning':
      return '当前已接通真实 session 元信息，任务拆解与时间线仍使用占位数据。';
    case 'idle':
      return '当前没有正在运行的 run，可以继续补充要求并发起下一轮执行。';
    case 'waiting_approval':
      return '当前会话停在待审批状态，后续将由 approval/task 数据替换占位内容。';
    case 'completed':
      return '当前会话已完成，前端已显示真实 session 状态和 workspace 文件树。';
    case 'blocked':
      return '当前会话被阻塞，需要先恢复后才能继续。';
    default:
      return '当前会话已接通真实 workspace/session CRUD，其余执行态内容仍为原型占位。';
  }
}

function getSelectedPath(fileTree: MockFileNode[], rootPath: string) {
  return fileTree[0]?.path ?? rootPath;
}

function getCheckpointPreview(resumeState?: ResumeSessionDto) {
  if (!resumeState?.checkpoint) {
    return 'Day 2 已接通 session CRUD 与 workspace 文件树。执行日志、任务流和审批细节将在后续阶段替换当前占位内容。';
  }

  try {
    return JSON.stringify(JSON.parse(resumeState.checkpoint), null, 2);
  } catch {
    return resumeState.checkpoint;
  }
}

function getCheckpointTitle(resumeState?: ResumeSessionDto) {
  return resumeState?.checkpoint ? 'Resume checkpoint' : 'Session overview';
}

function getDetailPane(
  session: SessionDto,
  fileTree: MockFileNode[],
  resumeState?: ResumeSessionDto
): MockDetailPane {
  return {
    activeTab: '文件',
    content: getCheckpointPreview(resumeState),
    contentTitle: getCheckpointTitle(resumeState),
    fileTree,
    metadata: [
      { label: '当前状态', value: getSessionProgressLabel(session.status) },
      { label: '最近更新', value: formatTimestamp(session.updatedAt) },
      {
        label: '恢复能力',
        value: resumeState?.canResume ? '可恢复' : '不可恢复'
      }
    ],
    selectedPath: getSelectedPath(fileTree, session.workspaceId),
    subtitle:
      '真实 workspace 文件树已接通，执行细节内容后续再由 task/event 数据替换。',
    title: '会话详情'
  };
}

export function buildWorkspaceTree(
  tree: WorkspaceTreeNodeDto[],
  rootPath: string
): MockFileNode[] {
  const mapNode = (
    node: WorkspaceTreeNodeDto,
    currentPath: string
  ): MockFileNode => {
    const nodePath = currentPath || rootPath;

    return {
      children: node.children?.map((child) =>
        mapNode(child, joinTreePath(nodePath, child.name))
      ),
      name: node.name,
      path: nodePath,
      type: node.type
    };
  };

  return tree.map((node) => mapNode(node, rootPath));
}

export function buildWorkspaceDetailPane(
  workspace: WorkspaceDto,
  fileTree: MockFileNode[]
): MockDetailPane {
  return {
    activeTab: '文件',
    content: `rootPath: ${workspace.rootPath}
createdAt: ${workspace.createdAt}
updatedAt: ${workspace.updatedAt}
lastOpenedAt: ${workspace.lastOpenedAt}`,
    contentTitle: workspace.rootPath,
    fileTree,
    metadata: [
      { label: 'Workspace', value: workspace.name },
      { label: '最近打开', value: formatTimestamp(workspace.lastOpenedAt) },
      { label: '会话数', value: '请选择左侧任务' }
    ],
    selectedPath: getSelectedPath(fileTree, workspace.rootPath),
    subtitle: '先从左侧选择一个已有复杂任务，或者创建一个新的 session。',
    title: '工作区详情'
  };
}

export function buildSessionView(
  session: SessionDto,
  fileTree: MockFileNode[],
  resumeState?: ResumeSessionDto
): MockSessionView {
  const pendingApprovals = resumeState?.pendingApprovals ?? [];
  const detailPane = getDetailPane(session, fileTree, resumeState);
  const template =
    getSessionMode(session.status) === 'planning'
      ? sampleSessions[0]!
      : sampleSessions[1]!;

  return {
    ...template,
    createdAt: session.createdAt,
    detailPane,
    goal: session.goalText,
    goalText: session.goalText,
    id: session.id,
    mode: getSessionMode(session.status),
    pendingApprovals:
      session.status === 'waiting_approval' ? pendingApprovals.length || 1 : 0,
    progressLabel: getSessionProgressLabel(session.status),
    status: session.status,
    summary: getSessionSummary(session),
    title: session.title,
    updatedAt: formatTimestamp(session.updatedAt),
    workspaceId: session.workspaceId,
    composerHint:
      session.status === 'idle'
        ? '当前会话空闲，可以发送“继续”或补充新的约束。'
        : session.status === 'waiting_approval'
          ? '当前会话正在等待审批，处理完成后会继续流式更新。'
          : '消息已经接通真实后端，回答和工具事件会通过 SSE 持续推送。',
    composerValue: ''
  };
}

export function buildSessionExcerpt(goalText: string) {
  return truncateText(goalText, 72);
}

export function formatSessionTimestamp(timestamp: string) {
  return formatTimestamp(timestamp);
}
