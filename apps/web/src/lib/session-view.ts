import type { SessionDto } from '@opencode/shared';

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

export function buildSessionExcerpt(goalText: string) {
  return truncateText(goalText, 72);
}

export function formatSessionTimestamp(timestamp: string) {
  return formatTimestamp(timestamp);
}

export function getSessionStateLabel(status: SessionDto['status']) {
  switch (status) {
    case 'planning':
      return '规划中';
    case 'idle':
      return '空闲';
    case 'executing':
      return '执行中';
    case 'waiting_approval':
      return '待审批';
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

export function getSessionComposerHint(status?: SessionDto['status']) {
  switch (status) {
    case 'idle':
      return '当前会话空闲，可以继续输入要求。';
    case 'planning':
      return '当前处于规划阶段，输入会继续补充或调整计划。';
    case 'waiting_approval':
      return '当前会话等待审批，处理后会继续执行。';
    case 'executing':
      return '会话正在执行中，完成后可继续输入。';
    case 'blocked':
      return '当前会话已阻塞，先处理错误或审批。';
    case 'completed':
      return '当前会话已完成，仍可继续补充要求。';
    default:
      return '输入消息后，agent 会继续通过流式消息更新。';
  }
}
