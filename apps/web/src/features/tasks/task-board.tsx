import type {
  SessionDto,
  SessionPlanFileDto,
  SessionPlanBoardDto,
  TaskDto,
  TaskStatus
} from '@opencode/shared';

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
      return 'bg-slate-100 text-slate-700';
    case 'ready':
      return 'bg-sky-100 text-sky-700';
    case 'running':
      return 'bg-amber-100 text-amber-800';
    case 'blocked':
      return 'bg-rose-100 text-rose-700';
    case 'waiting_approval':
      return 'bg-violet-100 text-violet-700';
    case 'done':
      return 'bg-emerald-100 text-emerald-700';
    case 'failed':
      return 'bg-red-100 text-red-700';
    default:
      return 'bg-slate-100 text-slate-700';
  }
}

function getPhaseLabel(status: SessionDto['status']) {
  return status === 'planning' ? '规划阶段' : '执行阶段';
}

function getProgressLabel(status: SessionDto['status']) {
  switch (status) {
    case 'planning':
      return '规划中';
    case 'idle':
      return '空闲，可继续';
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
      (task) =>
        task.status === 'running' || task.status === 'waiting_approval'
    ) ??
    board.tasks.find((task) => task.status === 'ready') ??
    board.tasks[0]
  );
}

function TaskCard({
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
  const startedAt = formatTimestamp(task.startedAt);
  const completedAt = formatTimestamp(task.completedAt);

  return (
    <article className="rounded-[24px] border border-sand bg-mist/80 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
            任务 {index + 1}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-ink">{task.title}</h3>
            {isCurrent ? (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800">
                当前任务
              </span>
            ) : null}
          </div>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${statusClassName(task.status)}`}
        >
          {statusLabel(task.status)}
        </span>
      </div>

      {task.description ? (
        <p className="mt-3 text-sm leading-6 text-slate-700">{task.description}</p>
      ) : null}

      <div className="mt-4 rounded-2xl bg-white/80 px-4 py-3 text-sm text-slate-700">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          验收标准
        </p>
        {task.acceptanceCriteria.length > 0 ? (
          <ul className="mt-2 space-y-2 leading-6">
            {task.acceptanceCriteria.map((item) => (
              <li key={item} className="rounded-2xl bg-mist/70 px-3 py-2">
                {item}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 leading-6 text-slate-500">尚未填写验收标准。</p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-600">
        {task.summaryText ? (
          <span className="rounded-full border border-white bg-white/80 px-3 py-1.5">
            {task.summaryText}
          </span>
        ) : null}
        {task.lastErrorText ? (
          <span className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1.5 text-rose-700">
            {task.lastErrorText}
          </span>
        ) : null}
        {pendingApprovalCount > 0 ? (
          <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-amber-800">
            {pendingApprovalCount} 个待审批动作
          </span>
        ) : null}
        {startedAt ? (
          <span className="rounded-full border border-white bg-white/80 px-3 py-1.5">
            开始于 {startedAt}
          </span>
        ) : null}
        {completedAt ? (
          <span className="rounded-full border border-white bg-white/80 px-3 py-1.5">
            完成于 {completedAt}
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
  const completedTaskCount = tasks.filter((task) => task.status === 'done').length;
  const planContent = planFile?.content?.trim()
    ? planFile.content
    : isLoading
      ? '正在读取当前 plan file...'
      : '当前还没有可展示的 plan file 内容。后续由 agent 在 plan 模式下创建并持续维护该文件。';

  return (
    <section className="rounded-[28px] border border-white/60 bg-white/80 p-5 shadow-panel backdrop-blur">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-ember">
            {getPhaseLabel(session.status)}
          </p>
          <h2 className="mt-1 text-xl font-semibold text-ink">{session.title}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            {session.goalText}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-sand bg-mist px-3 py-1.5 text-sm text-slate-700">
            {getProgressLabel(session.status)}
          </span>
          <span className="rounded-full border border-sand bg-mist px-3 py-1.5 text-sm text-slate-700">
            {tasks.length} 个任务
          </span>
          <span className="rounded-full border border-sand bg-mist px-3 py-1.5 text-sm text-slate-700">
            已完成 {completedTaskCount} 个
          </span>
          <span className="rounded-full border border-sand bg-mist px-3 py-1.5 text-sm text-slate-700">
            待审批 {board?.waitingApprovalTaskIds.length ?? 0} 个
          </span>
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)]">
        <div className="space-y-4">
          {isLoading && !board ? (
            <article className="rounded-[24px] border border-sand bg-mist/80 p-4 text-sm leading-6 text-slate-600">
              正在读取当前任务板...
            </article>
          ) : null}

          {!isLoading && tasks.length === 0 ? (
            <article className="rounded-[24px] border border-dashed border-sand bg-mist/60 p-5 text-sm leading-6 text-slate-600">
              {session.status === 'planning'
                ? '当前还没有真实任务。下一步应由 agent 在 plan 模式下创建结构化任务。'
                : '当前还没有可展示的真实任务。若直接进入 build，后续需要先补齐计划任务。'}
            </article>
          ) : null}

          {tasks.map((task, index) => (
            <TaskCard
              key={task.id}
              index={index}
              isCurrent={currentTask?.id === task.id}
              pendingApprovalCount={approvalCountByTaskId.get(task.id) ?? 0}
              task={task}
            />
          ))}
        </div>

        <aside className="space-y-4">
          <section className="rounded-[24px] border border-sand bg-mist/80 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
              当前 Plan File
            </p>
            <p className="mt-2 break-all rounded-2xl bg-white/80 px-3 py-2 text-xs text-slate-500">
              {planFile?.filePath ?? board?.currentPlan?.filePath ?? '尚未生成路径'}
            </p>
            <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-2xl bg-white/80 px-4 py-3 text-sm leading-6 text-slate-700">
              {planContent}
            </pre>
          </section>

          <section className="rounded-[24px] border border-sand bg-mist/80 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
              当前任务
            </p>
            {currentTask ? (
              <div className="mt-3 rounded-2xl bg-white/80 px-4 py-3 text-sm leading-6 text-slate-700">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-semibold text-ink">{currentTask.title}</p>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${statusClassName(currentTask.status)}`}
                  >
                    {statusLabel(currentTask.status)}
                  </span>
                </div>
                {currentTask.description ? (
                  <p className="mt-2">{currentTask.description}</p>
                ) : null}
                {currentTask.summaryText ? (
                  <p className="mt-3 rounded-2xl bg-mist/70 px-3 py-2 text-slate-700">
                    {currentTask.summaryText}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-3 text-sm leading-6 text-slate-600">
                当前还没有被标记为 current task 的真实任务。
              </p>
            )}
          </section>

          <section className="rounded-[24px] border border-sand bg-mist/80 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
              Board Stats
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl bg-white/80 px-4 py-3 text-sm text-slate-700">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Current Plan
                </p>
                <p className="mt-2 font-medium text-ink">
                  {board?.currentPlan ? '已初始化' : '未初始化'}
                </p>
              </div>
              <div className="rounded-2xl bg-white/80 px-4 py-3 text-sm text-slate-700">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Plan Created
                </p>
                <p className="mt-2 font-medium text-ink">
                  {formatTimestamp(board?.currentPlan?.createdAt) ?? '暂无'}
                </p>
              </div>
              <div className="rounded-2xl bg-white/80 px-4 py-3 text-sm text-slate-700">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Waiting Approval
                </p>
                <p className="mt-2 font-medium text-ink">
                  {board?.waitingApprovalTaskIds.length ?? 0}
                </p>
              </div>
              <div className="rounded-2xl bg-white/80 px-4 py-3 text-sm text-slate-700">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Session Pointer
                </p>
                <p className="mt-2 font-medium text-ink">
                  {session.currentTaskId ? '已指向当前任务' : '尚未设置'}
                </p>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}
