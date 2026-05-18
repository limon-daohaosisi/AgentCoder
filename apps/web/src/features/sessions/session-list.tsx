import type { FormEvent } from 'react';
import { useState } from 'react';
import type { SessionDto, SessionVariant } from '@opencode/shared';
import { Link } from '@tanstack/react-router';
import {
  buildSessionExcerpt,
  formatSessionTimestamp
} from '../../lib/session-view';

type SessionListProps = {
  currentSessionId?: string;
  errorMessage?: string;
  isCreating?: boolean;
  onCreateSession: (input: {
    defaultVariant: SessionVariant;
    goalText: string;
    title?: string;
  }) => void;
  sessions: SessionDto[];
  workspaceId: string;
};

function sessionStateLabel(status: SessionDto['status']) {
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

function sessionProgressLabel(status: SessionDto['status']) {
  switch (status) {
    case 'planning':
      return '等待规划';
    case 'idle':
      return '可继续';
    case 'waiting_approval':
      return '等待审批';
    case 'completed':
      return '完成';
    case 'blocked':
      return '已阻塞';
    case 'archived':
      return '归档';
    default:
      return '执行中';
  }
}

export function SessionList({
  currentSessionId,
  errorMessage,
  isCreating = false,
  onCreateSession,
  sessions,
  workspaceId
}: SessionListProps) {
  const [goalText, setGoalText] = useState('');
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [defaultVariant, setDefaultVariant] = useState<SessionVariant>('plan');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalizedGoalText = goalText.trim();

    if (!normalizedGoalText) {
      return;
    }

    onCreateSession({
      defaultVariant,
      goalText: normalizedGoalText,
      title: title.trim() || undefined
    });
    setGoalText('');
    setTitle('');
    setIsComposerOpen(false);
  }

  return (
    <aside className="rounded-[28px] border border-white/60 bg-white/80 p-5 shadow-panel backdrop-blur">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-ember">
            Complex Tasks
          </p>
          <h2 className="text-lg font-semibold text-ink">复杂任务</h2>
        </div>
        <button
          className="rounded-full border border-sand bg-mist px-3 py-1.5 text-xs font-semibold text-ink"
          onClick={() => setIsComposerOpen((currentValue) => !currentValue)}
          type="button"
        >
          新建任务
        </button>
      </div>

      {isComposerOpen ? (
        <form
          className="mb-4 space-y-3 rounded-[24px] border border-sand bg-mist/80 p-4"
          onSubmit={handleSubmit}
        >
          <input
            className="w-full rounded-2xl border border-white bg-white px-4 py-3 text-sm text-ink outline-none"
            onChange={(event) => setTitle(event.target.value)}
            placeholder="可选标题"
            value={title}
          />
          <textarea
            className="min-h-28 w-full resize-none rounded-2xl border border-white bg-white px-4 py-3 text-sm text-ink outline-none"
            onChange={(event) => setGoalText(event.target.value)}
            placeholder="描述这个复杂任务的目标"
            value={goalText}
          />
          <div className="inline-flex rounded-full border border-sand bg-white p-1 text-xs font-semibold text-slate-600">
            {(['plan', 'build'] as const).map((variant) => {
              const active = variant === defaultVariant;

              return (
                <button
                  className={
                    active
                      ? 'rounded-full bg-ink px-3 py-1.5 text-white'
                      : 'rounded-full px-3 py-1.5 text-slate-600'
                  }
                  key={variant}
                  onClick={() => setDefaultVariant(variant)}
                  type="button"
                >
                  {variant === 'plan' ? 'Plan 默认' : 'Build 默认'}
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs leading-5 text-slate-500">
              `goalText` 会直接写入 session current-state。
            </p>
            <button
              className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isCreating || goalText.trim().length === 0}
              type="submit"
            >
              {isCreating ? '创建中...' : '创建 session'}
            </button>
          </div>
        </form>
      ) : null}

      {errorMessage ? (
        <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}

      <div className="space-y-3">
        {sessions.map((session) => (
          <Link
            key={session.id}
            className={
              session.id === currentSessionId
                ? 'block rounded-2xl border border-amber-300 bg-amber-50 p-4 shadow-sm transition'
                : 'block rounded-2xl border border-sand bg-mist p-4 transition hover:border-amber-300 hover:bg-amber-50'
            }
            to="/workspace/$workspaceId/session/$sessionId"
            params={{ sessionId: session.id, workspaceId }}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium text-ink">{session.title}</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {buildSessionExcerpt(session.goalText)}
                </p>
              </div>
              <span className="rounded-full bg-white px-2 py-1 text-xs text-slate-500">
                {formatSessionTimestamp(session.updatedAt)}
              </span>
            </div>

            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full border border-white bg-white/80 px-3 py-1.5 text-slate-600">
                {sessionStateLabel(session.status)}
              </span>
              <span className="rounded-full border border-white bg-white/80 px-3 py-1.5 text-slate-600">
                {sessionProgressLabel(session.status)}
              </span>
              <span className="rounded-full border border-white bg-white/80 px-3 py-1.5 text-slate-600">
                {session.defaultVariant === 'plan' ? '默认 Plan' : '默认 Build'}
              </span>
              {session.status === 'waiting_approval' ? (
                <span className="rounded-full border border-amber-200 bg-amber-100 px-3 py-1.5 text-amber-800">
                  1 个待审批
                </span>
              ) : null}
            </div>
          </Link>
        ))}

        {sessions.length === 0 ? (
          <article className="rounded-[24px] border border-dashed border-sand bg-mist/60 p-4 text-sm leading-6 text-slate-600">
            当前 workspace 还没有 session。先创建一个 goal-driven
            复杂任务，再进入右侧工作台。
          </article>
        ) : null}
      </div>
    </aside>
  );
}
