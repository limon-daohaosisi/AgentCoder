import type {
  SessionDto,
  SessionPlanBoardDto,
  SessionPlanFileDto,
  TaskDto,
  TaskStatus
} from '@opencode/shared';
import { getSessionStateLabel } from '../../lib/session-view';

type TaskBoardProps = {
  board?: SessionPlanBoardDto;
  isLoading?: boolean;
  planFile?: SessionPlanFileDto;
  session: SessionDto;
};

function statusLabel(status: TaskStatus) {
  switch (status) {
    case 'todo':
      return '待执行';
    case 'ready':
      return '可开始';
    case 'running':
      return '进行中';
    case 'blocked':
      return '已阻塞';
    case 'waiting_approval':
      return '待审批';
    case 'done':
      return '已完成';
    case 'failed':
      return '失败';
    default:
      return status;
  }
}

function statusClassName(status: TaskStatus) {
  switch (status) {
    case 'todo':
      return 'bg-white/8 text-white/65';
    case 'ready':
      return 'bg-sky-400/10 text-sky-200';
    case 'running':
      return 'bg-amber-300/10 text-amber-200';
    case 'blocked':
      return 'bg-rose-400/10 text-rose-200';
    case 'waiting_approval':
      return 'bg-violet-400/10 text-violet-200';
    case 'done':
      return 'bg-emerald-400/10 text-emerald-200';
    case 'failed':
      return 'bg-red-400/10 text-red-200';
    default:
      return 'bg-white/8 text-white/65';
  }
}

function formatTimestamp(value?: string) {
  if (!value) {
    return undefined;
  }

  return new Date(value).toLocaleString('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit'
  });
}

function buildApprovalCountByTaskId(taskIds: string[]) {
  const counts = new Map<string, number>();

  for (const taskId of taskIds) {
    counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
  }

  return counts;
}

function resolveCurrentTask(board?: SessionPlanBoardDto) {
  if (!board) {
    return undefined;
  }

  return (
    board.currentTask ??
    board.tasks.find(
      (task) => task.status === 'running' || task.status === 'waiting_approval'
    ) ??
    board.tasks.find((task) => task.status === 'ready') ??
    board.tasks[0]
  );
}

function TaskRow({
  index,
  isCurrent,
  pendingApprovalCount,
  task
}: {
  index: number;
  isCurrent: boolean;
  pendingApprovalCount: number;
  task: TaskDto;
}) {
  const completedAt = formatTimestamp(task.completedAt);
  const startedAt = formatTimestamp(task.startedAt);

  return (
    <article
      className={
        isCurrent
          ? 'rounded-[16px] border border-white/18 bg-[#1f1f1f] px-4 py-4'
          : 'rounded-[16px] border border-white/8 bg-[#262626] px-4 py-4'
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/35">
            Task {index + 1}
          </p>
          <h3 className="mt-1 text-sm font-semibold text-white">
            {task.title}
          </h3>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-[11px] font-semibold ${statusClassName(task.status)}`}
        >
          {statusLabel(task.status)}
        </span>
      </div>

      {task.summaryText ? (
        <p className="mt-3 text-sm leading-6 text-white/72">
          {task.summaryText}
        </p>
      ) : task.description ? (
        <p className="mt-3 text-sm leading-6 text-white/55">
          {task.description}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
        {isCurrent ? (
          <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1 text-amber-200">
            当前任务
          </span>
        ) : null}
        {pendingApprovalCount > 0 ? (
          <span className="rounded-full border border-violet-300/30 bg-violet-300/10 px-3 py-1 text-violet-200">
            待审批 {pendingApprovalCount}
          </span>
        ) : null}
        {task.lastErrorText ? (
          <span className="rounded-full border border-rose-300/30 bg-rose-300/10 px-3 py-1 text-rose-200">
            {task.lastErrorText}
          </span>
        ) : null}
        {startedAt ? (
          <span className="rounded-full border border-white/8 bg-white/6 px-3 py-1 text-white/45">
            开始 {startedAt}
          </span>
        ) : null}
        {completedAt ? (
          <span className="rounded-full border border-white/8 bg-white/6 px-3 py-1 text-white/45">
            完成 {completedAt}
          </span>
        ) : null}
      </div>
    </article>
  );
}

export function TaskBoard({
  board,
  isLoading = false,
  planFile,
  session
}: TaskBoardProps) {
  const tasks = board?.tasks ?? [];
  const currentTask = resolveCurrentTask(board);
  const approvalCountByTaskId = buildApprovalCountByTaskId(
    board?.waitingApprovalTaskIds ?? []
  );
  const completedTaskCount = tasks.filter(
    (task) => task.status === 'done'
  ).length;
  const planSummary =
    board?.currentPlan?.summaryText?.trim() ||
    planFile?.content
      ?.trim()
      .split('\n')
      .find((line) => line.trim()) ||
    '当前还没有可展示的计划摘要。';

  return (
    <section className="flex h-screen min-h-0 flex-col overflow-hidden bg-[#333333] text-white">
      <div className="px-5 py-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/45">
          Tasks
        </p>
        <h2 className="mt-1 text-lg font-semibold">{session.title}</h2>
        <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
          <span className="rounded-full border border-white/8 bg-white/6 px-3 py-1 text-white/60">
            {getSessionStateLabel(session.status)}
          </span>
          <span className="rounded-full border border-white/8 bg-white/6 px-3 py-1 text-white/60">
            共 {tasks.length} 个任务
          </span>
          <span className="rounded-full border border-white/8 bg-white/6 px-3 py-1 text-white/60">
            已完成 {completedTaskCount}
          </span>
          <span className="rounded-full border border-white/8 bg-white/6 px-3 py-1 text-white/60">
            待审批 {board?.waitingApprovalTaskIds.length ?? 0}
          </span>
        </div>
        <p className="mt-4 text-sm leading-6 text-white/50">{planSummary}</p>
      </div>

      <div className="console-scroll flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {isLoading && !board ? (
          <article className="rounded-[16px] border border-white/8 bg-[#262626] p-4 text-sm leading-6 text-white/45">
            正在读取当前任务板...
          </article>
        ) : null}

        {!isLoading && tasks.length === 0 ? (
          <article className="rounded-[16px] border border-dashed border-white/10 bg-[#262626] p-4 text-sm leading-6 text-white/45">
            {session.status === 'planning'
              ? '当前还没有真实任务。下一步应由 agent 在 plan 模式下创建结构化任务。'
              : '当前还没有可展示的真实任务。'}
          </article>
        ) : null}

        {tasks.map((task, index) => (
          <TaskRow
            key={task.id}
            index={index}
            isCurrent={currentTask?.id === task.id}
            pendingApprovalCount={approvalCountByTaskId.get(task.id) ?? 0}
            task={task}
          />
        ))}
      </div>
    </section>
  );
}
