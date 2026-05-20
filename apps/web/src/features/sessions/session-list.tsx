import type { FormEvent } from 'react';
import { useState } from 'react';
import type { SessionDto, SessionVariant } from '@opencode/shared';
import { Link } from '@tanstack/react-router';
import {
  buildSessionExcerpt,
  formatSessionTimestamp,
  getSessionStateLabel
} from '../../lib/session-view';

type SessionListProps = {
  currentSessionId?: string;
  errorMessage?: string;
  isCreating?: boolean;
  onSwitchWorkspace?: () => void;
  onCreateSession: (input: {
    defaultVariant: SessionVariant;
    goalText: string;
    title?: string;
  }) => void;
  sessions: SessionDto[];
  workspaceName: string;
  workspaceRootPath: string;
  workspaceId: string;
};

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
  onSwitchWorkspace,
  onCreateSession,
  sessions,
  workspaceName,
  workspaceRootPath,
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
    <aside className="flex h-screen min-h-0 flex-col overflow-hidden bg-[#2d2d2d] text-white">
      <div className="px-5 py-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/45">
            Workspace
          </p>
          <h2 className="mt-1 text-lg font-semibold">{workspaceName}</h2>
          <p className="mt-2 text-sm leading-6 text-white/45">
            {workspaceRootPath}
          </p>
        </div>
        {onSwitchWorkspace ? (
          <button
            className="mt-4 rounded-full border border-white/10 bg-white/6 px-3 py-1.5 text-xs font-semibold text-white/75 transition hover:bg-white/10"
            onClick={onSwitchWorkspace}
            type="button"
          >
            Switch Workspace
          </button>
        ) : null}
        <button
          className="mt-4 h-10 w-full rounded-[12px] bg-[#d9d9d9] px-4 text-sm font-semibold text-black transition hover:bg-white"
          onClick={() => setIsComposerOpen((currentValue) => !currentValue)}
          type="button"
        >
          {isComposerOpen ? '关闭新建' : '新增 session'}
        </button>
      </div>

      {isComposerOpen ? (
        <form className="px-5 py-4" onSubmit={handleSubmit}>
          <input
            className="w-full rounded-[14px] border border-white/10 bg-[#1f1f1f] px-4 py-3 text-sm text-white outline-none placeholder:text-white/35"
            onChange={(event) => setTitle(event.target.value)}
            placeholder="可选标题"
            value={title}
          />
          <textarea
            className="mt-3 min-h-24 w-full resize-none rounded-[14px] border border-white/10 bg-[#1f1f1f] px-4 py-3 text-sm text-white outline-none placeholder:text-white/35"
            onChange={(event) => setGoalText(event.target.value)}
            placeholder="描述这个复杂任务的目标"
            value={goalText}
          />
          <div className="mt-3 inline-flex rounded-full border border-white/10 bg-[#1f1f1f] p-1 text-xs font-semibold text-white/55">
            {(['plan', 'build'] as const).map((variant) => {
              const active = variant === defaultVariant;

              return (
                <button
                  className={
                    active
                      ? 'rounded-full bg-[#d9d9d9] px-3 py-1.5 text-black'
                      : 'rounded-full px-3 py-1.5 text-white/55'
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
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs leading-5 text-white/40">
              `goalText` 会直接写入 session current-state。
            </p>
            <button
              className="rounded-full bg-[#d9d9d9] px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isCreating || goalText.trim().length === 0}
              type="submit"
            >
              {isCreating ? '创建中...' : '创建 session'}
            </button>
          </div>
        </form>
      ) : null}

      {errorMessage ? (
        <div className="mx-5 my-4 rounded-[14px] border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {errorMessage}
        </div>
      ) : null}

      <div className="console-scroll flex-1 space-y-2 overflow-y-auto px-4 py-4">
        {sessions.map((session) => (
          <Link
            key={session.id}
            className={
              session.id === currentSessionId
                ? 'block rounded-[14px] border border-white/20 bg-[#1f1f1f] px-4 py-3 transition'
                : 'block rounded-[14px] border border-transparent bg-transparent px-4 py-3 transition hover:border-white/10 hover:bg-[#1f1f1f]'
            }
            to="/workspace/$workspaceId/session/$sessionId"
            params={{ sessionId: session.id, workspaceId }}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium text-white">{session.title}</p>
                <p className="mt-2 text-sm leading-6 text-white/45">
                  {buildSessionExcerpt(session.goalText)}
                </p>
              </div>
              <span className="rounded-full bg-white/6 px-2 py-1 text-[11px] text-white/40">
                {formatSessionTimestamp(session.updatedAt)}
              </span>
            </div>

            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full border border-white/8 bg-white/6 px-3 py-1.5 text-white/60">
                {getSessionStateLabel(session.status)}
              </span>
              <span className="rounded-full border border-white/8 bg-white/6 px-3 py-1.5 text-white/60">
                {sessionProgressLabel(session.status)}
              </span>
              <span className="rounded-full border border-white/8 bg-white/6 px-3 py-1.5 text-white/60">
                {session.defaultVariant === 'plan' ? '默认 Plan' : '默认 Build'}
              </span>
              {session.status === 'waiting_approval' ? (
                <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1.5 text-amber-200">
                  1 个待审批
                </span>
              ) : null}
            </div>
          </Link>
        ))}

        {sessions.length === 0 ? (
          <article className="rounded-[14px] border border-dashed border-white/10 bg-[#1f1f1f] p-4 text-sm leading-6 text-white/45">
            当前 workspace 还没有 session。先创建一个 goal-driven
            复杂任务，再进入右侧工作台。
          </article>
        ) : null}
      </div>
    </aside>
  );
}
