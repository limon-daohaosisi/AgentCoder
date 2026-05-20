import type { FormEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { SessionVariant } from '@opencode/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useParams
} from '@tanstack/react-router';
import { AppShell } from './components/app-shell';
import { Composer } from './features/chat/composer';
import { MessageList } from './features/chat/message-list';
import { SessionList } from './features/sessions/session-list';
import { TaskBoard } from './features/tasks/task-board';
import { useSessionStream } from './hooks/use-session-stream';
import {
  approveApproval,
  cancelCurrentRun,
  createSession,
  createWorkspace,
  getSession,
  getSessionPlanFile,
  getSessionPlanBoard,
  listMessages,
  listSessions,
  listWorkspaces,
  manualCompact,
  rejectApproval,
  resumeSession,
  submitSessionMessage
} from './lib/api';
import {
  formatSessionTimestamp,
  getSessionComposerHint
} from './lib/session-view';
import { projectMessages } from './lib/message-projection';

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function RootLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

function HomePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [rootPath, setRootPath] = useState('');
  const workspaceListQuery = useQuery({
    queryFn: listWorkspaces,
    queryKey: ['workspaces']
  });
  const createWorkspaceMutation = useMutation({
    mutationFn: createWorkspace,
    onSuccess: async (workspace) => {
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      setRootPath('');
      await navigate({
        params: {
          workspaceId: workspace.id
        },
        to: '/workspace/$workspaceId'
      });
    }
  });

  function handleCreateWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalizedRootPath = rootPath.trim();

    if (!normalizedRootPath) {
      return;
    }

    createWorkspaceMutation.mutate({
      rootPath: normalizedRootPath
    });
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-6xl items-center justify-center px-6 py-12">
      <section className="w-full rounded-[32px] border border-white/60 bg-white/85 p-10 shadow-panel backdrop-blur">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-ember">
          OpenCode Web Lite
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-tight text-ink">
          Workspace 与 Session
          顶层数据与任务板已经接到真实后端，时间线和详情仍有原型占位。
        </h1>
        <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
          现在可以直接创建 workspace、查看已有 session、进入真实的文件树与
          session current-state。任务板已经开始消费真实 plan/task
          数据，时间线和审批详情会在后续阶段继续补齐更多真实内容。
        </p>

        <form
          className="mt-8 rounded-[28px] border border-sand bg-mist/80 p-5"
          onSubmit={handleCreateWorkspace}
        >
          <div className="flex flex-col gap-3 md:flex-row">
            <input
              className="flex-1 rounded-full border border-white bg-white px-5 py-3 text-sm text-ink outline-none"
              onChange={(event) => setRootPath(event.target.value)}
              placeholder="输入一个本地 workspace 根目录，例如 /home/me/project"
              value={rootPath}
            />
            <button
              className="rounded-full bg-ink px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={
                createWorkspaceMutation.isPending ||
                rootPath.trim().length === 0
              }
              type="submit"
            >
              {createWorkspaceMutation.isPending
                ? '创建中...'
                : '创建或打开 Workspace'}
            </button>
          </div>
          {createWorkspaceMutation.isError ? (
            <p className="mt-3 text-sm text-red-700">
              {getErrorMessage(createWorkspaceMutation.error)}
            </p>
          ) : null}
        </form>

        <div className="mt-8">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-ember">
                Recent Workspaces
              </p>
              <h2 className="text-lg font-semibold text-ink">最近工作区</h2>
            </div>
            <span className="rounded-full border border-sand bg-mist px-4 py-2 text-sm text-slate-600">
              {workspaceListQuery.data?.length ?? 0} 个 workspace
            </span>
          </div>

          {workspaceListQuery.isLoading ? (
            <div className="rounded-[24px] border border-sand bg-mist/70 p-5 text-sm text-slate-600">
              正在读取 workspace 列表...
            </div>
          ) : null}

          {workspaceListQuery.isError ? (
            <div className="rounded-[24px] border border-red-200 bg-red-50 p-5 text-sm text-red-700">
              {getErrorMessage(workspaceListQuery.error)}
            </div>
          ) : null}

          {workspaceListQuery.data && workspaceListQuery.data.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              {workspaceListQuery.data.map((workspace) => (
                <Link
                  key={workspace.id}
                  className="block rounded-[28px] border border-sand bg-mist/80 p-5 transition hover:border-amber-300 hover:bg-amber-50"
                  params={{ workspaceId: workspace.id }}
                  to="/workspace/$workspaceId"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-lg font-semibold text-ink">
                        {workspace.name}
                      </p>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        {workspace.rootPath}
                      </p>
                    </div>
                    <span className="rounded-full bg-white px-3 py-1 text-xs text-slate-500">
                      {formatSessionTimestamp(workspace.lastOpenedAt)}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          ) : null}

          {workspaceListQuery.data?.length === 0 ? (
            <div className="rounded-[24px] border border-dashed border-sand bg-mist/60 p-5 text-sm leading-6 text-slate-600">
              还没有 workspace。先输入一个项目目录，前端就会使用新的 Day 2 CRUD
              接口创建或复用它。
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function EmptyWorkspaceState() {
  return (
    <section className="rounded-[28px] border border-white/60 bg-white/80 p-6 shadow-panel backdrop-blur">
      <p className="text-xs font-semibold uppercase tracking-[0.25em] text-ember">
        Session Placeholder
      </p>
      <h2 className="mt-1 text-xl font-semibold text-ink">
        先创建一个复杂任务
      </h2>
      <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">
        当前 workspace 已加载成功，但还没有可展示的
        session。左侧“新建任务”会直接调用 `POST
        /api/sessions`，创建完成后会自动跳转到对应 session。
      </p>
    </section>
  );
}

function WorkspaceScreen(props: { sessionId?: string; workspaceId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [composerVariant, setComposerVariant] =
    useState<SessionVariant>('plan');
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const forceScrollToBottomRef = useRef(false);
  const previousSessionIdRef = useRef<string | undefined>(props.sessionId);
  const stream = useSessionStream(props.sessionId, props.workspaceId);
  const workspaceListQuery = useQuery({
    queryFn: listWorkspaces,
    queryKey: ['workspaces']
  });
  const sessionListQuery = useQuery({
    enabled: props.workspaceId.length > 0,
    queryFn: () => listSessions(props.workspaceId),
    queryKey: ['sessions', props.workspaceId]
  });
  const sessionQuery = useQuery({
    enabled: Boolean(props.sessionId),
    queryFn: () => getSession(props.sessionId!),
    queryKey: ['session', props.sessionId]
  });
  const planBoardQuery = useQuery({
    enabled: Boolean(props.sessionId),
    queryFn: () => getSessionPlanBoard(props.sessionId!),
    queryKey: ['session-plan-board', props.sessionId]
  });
  const planFileQuery = useQuery({
    enabled: Boolean(props.sessionId),
    queryFn: () => getSessionPlanFile(props.sessionId!),
    queryKey: ['session-plan-file', props.sessionId]
  });
  const resumeQuery = useQuery({
    enabled: Boolean(props.sessionId),
    queryFn: () => resumeSession(props.sessionId!),
    queryKey: ['resume-session', props.sessionId]
  });
  const messagesQuery = useQuery({
    enabled: Boolean(props.sessionId),
    queryFn: () => listMessages(props.sessionId!),
    queryKey: ['messages', props.sessionId]
  });
  const createSessionMutation = useMutation({
    mutationFn: (input: {
      defaultVariant: SessionVariant;
      goalText: string;
      title?: string;
    }) =>
      createSession({
        ...input,
        workspaceId: props.workspaceId
      }),
    onSuccess: async (session) => {
      await queryClient.invalidateQueries({
        queryKey: ['sessions', props.workspaceId]
      });
      await queryClient.invalidateQueries({
        queryKey: ['session', session.id]
      });
      await navigate({
        params: {
          sessionId: session.id,
          workspaceId: props.workspaceId
        },
        to: '/workspace/$workspaceId/session/$sessionId'
      });
    }
  });
  const submitMessageMutation = useMutation({
    mutationFn: (input: { content: string; variant: SessionVariant }) => {
      if (!props.sessionId) {
        throw new Error('当前还没有选中的 session');
      }

      return submitSessionMessage(props.sessionId, input);
    },
    onSuccess: async (response) => {
      if (!props.sessionId) {
        return;
      }

      queryClient.setQueryData(['messages', props.sessionId], (current) => {
        const currentMessages = Array.isArray(current) ? current : [];

        return currentMessages.some(
          (message) =>
            typeof message === 'object' &&
            message !== null &&
            'id' in message &&
            message.id === response.message.id
        )
          ? currentMessages
          : [...currentMessages, response.message];
      });

      await queryClient.invalidateQueries({
        queryKey: ['session', props.sessionId]
      });
      await queryClient.invalidateQueries({
        queryKey: ['session-plan-board', props.sessionId]
      });
      await queryClient.invalidateQueries({
        queryKey: ['session-plan-file', props.sessionId]
      });
      await queryClient.invalidateQueries({
        queryKey: ['resume-session', props.sessionId]
      });
      await queryClient.invalidateQueries({
        queryKey: ['sessions', props.workspaceId]
      });
    }
  });
  const manualCompactMutation = useMutation({
    mutationFn: () => {
      if (!props.sessionId) {
        throw new Error('当前还没有选中的 session');
      }

      return manualCompact(props.sessionId);
    },
    onSuccess: async () => {
      if (!props.sessionId) {
        return;
      }

      await queryClient.invalidateQueries({
        queryKey: ['messages', props.sessionId]
      });
      await queryClient.invalidateQueries({
        queryKey: ['session', props.sessionId]
      });
      await queryClient.invalidateQueries({
        queryKey: ['session-plan-board', props.sessionId]
      });
      await queryClient.invalidateQueries({
        queryKey: ['session-plan-file', props.sessionId]
      });
      await queryClient.invalidateQueries({
        queryKey: ['resume-session', props.sessionId]
      });
      await queryClient.invalidateQueries({
        queryKey: ['sessions', props.workspaceId]
      });
    }
  });
  const cancelCurrentRunMutation = useMutation({
    mutationFn: () => {
      if (!props.sessionId) {
        throw new Error('当前还没有选中的 session');
      }

      return cancelCurrentRun(props.sessionId);
    },
    onSuccess: async (response) => {
      if (!props.sessionId) {
        return;
      }

      queryClient.setQueryData(['session', props.sessionId], response.session);

      await queryClient.invalidateQueries({
        queryKey: ['messages', props.sessionId]
      });
      await queryClient.invalidateQueries({
        queryKey: ['session-plan-board', props.sessionId]
      });
      await queryClient.invalidateQueries({
        queryKey: ['session-plan-file', props.sessionId]
      });
      await queryClient.invalidateQueries({
        queryKey: ['resume-session', props.sessionId]
      });
      await queryClient.invalidateQueries({
        queryKey: ['sessions', props.workspaceId]
      });
    }
  });

  const workspace = workspaceListQuery.data?.find(
    (item) => item.id === props.workspaceId
  );

  useEffect(() => {
    if (props.sessionId || !sessionListQuery.data?.length) {
      return;
    }

    void navigate({
      params: {
        sessionId: sessionListQuery.data[0]!.id,
        workspaceId: props.workspaceId
      },
      replace: true,
      to: '/workspace/$workspaceId/session/$sessionId'
    });
  }, [navigate, props.sessionId, props.workspaceId, sessionListQuery.data]);

  const currentSession =
    sessionQuery.data ??
    sessionListQuery.data?.find((session) => session.id === props.sessionId);

  useEffect(() => {
    if (!currentSession) {
      setComposerVariant('plan');
      return;
    }

    const lastUserVariant = [...(messagesQuery.data ?? [])]
      .reverse()
      .find((message) => message.role === 'user')?.runtime?.variant;

    setComposerVariant(lastUserVariant ?? currentSession.defaultVariant);
  }, [currentSession, messagesQuery.data]);

  useEffect(() => {
    if (previousSessionIdRef.current !== props.sessionId) {
      previousSessionIdRef.current = props.sessionId;
      shouldStickToBottomRef.current = true;
      forceScrollToBottomRef.current = true;
    }
  }, [props.sessionId]);

  if (!workspace && workspaceListQuery.isLoading) {
    return (
      <div className="min-h-screen px-4 py-4 md:px-6">
        <div className="rounded-[28px] border border-white/60 bg-white/80 px-5 py-8 text-sm text-slate-600 shadow-panel backdrop-blur">
          正在读取 workspace...
        </div>
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="min-h-screen px-4 py-4 md:px-6">
        <div className="rounded-[28px] border border-red-200 bg-red-50 px-5 py-8 text-sm text-red-700 shadow-panel">
          {workspaceListQuery.isError
            ? getErrorMessage(workspaceListQuery.error)
            : 'Workspace not found'}
        </div>
      </div>
    );
  }

  const currentSessionData = planBoardQuery.data?.session ?? currentSession;
  const liveMessages = projectMessages(messagesQuery.data ?? [], stream.events);
  const canSubmitMessage =
    currentSessionData?.status === 'planning' ||
    currentSessionData?.status === 'idle';
  const canCancelRun =
    currentSessionData?.status === 'executing' ||
    currentSessionData?.status === 'waiting_approval';
  const pendingApprovals = resumeQuery.data?.pendingApprovals ?? [];
  const isComposerDisabled =
    !props.sessionId ||
    submitMessageMutation.isPending ||
    manualCompactMutation.isPending ||
    !canSubmitMessage;

  useEffect(() => {
    const container = messageScrollRef.current;

    if (!container) {
      return;
    }

    const stickToBottom =
      forceScrollToBottomRef.current || shouldStickToBottomRef.current;

    if (!stickToBottom) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      const node = messageScrollRef.current;

      if (!node) {
        return;
      }

      node.scrollTop = node.scrollHeight;
      shouldStickToBottomRef.current = true;
      forceScrollToBottomRef.current = false;
    });

    return () => cancelAnimationFrame(frame);
  }, [liveMessages]);

  function isManualCompactCommand(content: string) {
    return content.trimStart().startsWith('/compact');
  }

  function handleComposerSubmit(content: string) {
    forceScrollToBottomRef.current = true;
    shouldStickToBottomRef.current = true;

    if (isManualCompactCommand(content)) {
      manualCompactMutation.mutate();
      return;
    }

    submitMessageMutation.mutate({ content, variant: composerVariant });
  }

  function handleMessageScroll() {
    const container = messageScrollRef.current;

    if (!container) {
      return;
    }

    const distanceToBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;

    shouldStickToBottomRef.current = distanceToBottom <= 24;
  }

  async function handleApprovalAction(
    approvalId: string,
    decision: 'approve' | 'reject'
  ) {
    if (decision === 'approve') {
      await approveApproval(approvalId);
    } else {
      await rejectApproval(approvalId);
    }

    if (!props.sessionId) {
      return;
    }

    await queryClient.invalidateQueries({
      queryKey: ['messages', props.sessionId]
    });
    await queryClient.invalidateQueries({
      queryKey: ['resume-session', props.sessionId]
    });
    await queryClient.invalidateQueries({
      queryKey: ['session', props.sessionId]
    });
    await queryClient.invalidateQueries({
      queryKey: ['session-plan-board', props.sessionId]
    });
    await queryClient.invalidateQueries({
      queryKey: ['session-plan-file', props.sessionId]
    });
    await queryClient.invalidateQueries({
      queryKey: ['sessions', props.workspaceId]
    });
  }

  return (
    <div className="h-screen overflow-hidden bg-[#1f1f1f] text-white">
      <div className="grid h-screen xl:grid-cols-[340px_minmax(0,1fr)_360px]">
        <SessionList
          currentSessionId={currentSession?.id}
          errorMessage={
            createSessionMutation.isError
              ? getErrorMessage(createSessionMutation.error)
              : undefined
          }
          isCreating={createSessionMutation.isPending}
          onSwitchWorkspace={() => {
            void navigate({ to: '/' });
          }}
          onCreateSession={(input) => createSessionMutation.mutate(input)}
          sessions={sessionListQuery.data ?? []}
          workspaceName={workspace.name}
          workspaceRootPath={workspace.rootPath}
          workspaceId={workspace.id}
        />

        <div className="flex h-screen min-h-0 flex-col bg-[#242424]">
          <div className="px-5 py-5">
            <p className="text-sm text-white/60">
              {currentSession?.title ??
                '选择一个 session，或在左侧创建新的复杂任务'}
            </p>
          </div>

          {sessionListQuery.isError ? (
            <section className="mx-5 mt-5 rounded-[16px] border border-red-400/40 bg-red-500/10 p-5 text-sm text-red-200">
              {getErrorMessage(sessionListQuery.error)}
            </section>
          ) : null}

          {sessionQuery.isError ? (
            <section className="mx-5 mt-5 rounded-[16px] border border-red-400/40 bg-red-500/10 p-5 text-sm text-red-200">
              {getErrorMessage(sessionQuery.error)}
            </section>
          ) : null}

          {planBoardQuery.isError ? (
            <section className="mx-5 mt-5 rounded-[16px] border border-red-400/40 bg-red-500/10 p-5 text-sm text-red-200">
              {getErrorMessage(planBoardQuery.error)}
            </section>
          ) : null}

          {currentSessionData ? (
            <>
              <div
                className="console-scroll flex-1 overflow-y-auto px-5 py-5"
                onScroll={handleMessageScroll}
                ref={messageScrollRef}
              >
                <MessageList
                  approvals={pendingApprovals}
                  messages={liveMessages}
                  onApprove={(approvalId) =>
                    void handleApprovalAction(approvalId, 'approve')
                  }
                  onReject={(approvalId) =>
                    void handleApprovalAction(approvalId, 'reject')
                  }
                  planFile={planFileQuery.data}
                />
              </div>

              <div className="shrink-0 px-5 pb-4">
                {cancelCurrentRunMutation.isError ? (
                  <p className="mb-3 text-sm text-red-200">
                    {getErrorMessage(cancelCurrentRunMutation.error)}
                  </p>
                ) : null}
                {submitMessageMutation.isError ? (
                  <p className="mb-3 text-sm text-red-200">
                    {getErrorMessage(submitMessageMutation.error)}
                  </p>
                ) : null}
                {manualCompactMutation.isError ? (
                  <p className="mb-3 text-sm text-red-200">
                    {getErrorMessage(manualCompactMutation.error)}
                  </p>
                ) : null}
                {canCancelRun ? (
                  <div className="mb-3 flex justify-end">
                    <button
                      className="rounded-full border border-red-300/25 bg-red-300/10 px-3 py-1.5 text-xs font-semibold text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={cancelCurrentRunMutation.isPending}
                      onClick={() => cancelCurrentRunMutation.mutate()}
                      type="button"
                    >
                      {cancelCurrentRunMutation.isPending
                        ? '取消中...'
                        : '取消当前运行'}
                    </button>
                  </div>
                ) : null}
                <Composer
                  defaultValue=""
                  disabled={isComposerDisabled}
                  hint={getSessionComposerHint(currentSessionData.status)}
                  isSubmitting={
                    submitMessageMutation.isPending ||
                    manualCompactMutation.isPending
                  }
                  onVariantChange={setComposerVariant}
                  onSubmit={handleComposerSubmit}
                  variant={composerVariant}
                />
              </div>
            </>
          ) : (
            <div className="p-5">
              <EmptyWorkspaceState />
            </div>
          )}
        </div>

        {currentSessionData ? (
          <TaskBoard
            board={planBoardQuery.data}
            isLoading={planBoardQuery.isLoading || planFileQuery.isLoading}
            planFile={planFileQuery.data}
            session={currentSessionData}
          />
        ) : (
          <div className="bg-[#333333]" />
        )}
      </div>
    </div>
  );
}

function WorkspacePage() {
  const { workspaceId } = useParams({
    from: '/workspace/$workspaceId'
  });

  return <WorkspaceScreen workspaceId={workspaceId} />;
}

function WorkspaceSessionPage() {
  const { sessionId, workspaceId } = useParams({
    from: '/workspace/$workspaceId/session/$sessionId'
  });

  return <WorkspaceScreen sessionId={sessionId} workspaceId={workspaceId} />;
}

const rootRoute = createRootRoute({
  component: RootLayout
});

const homeRoute = createRoute({
  component: HomePage,
  getParentRoute: () => rootRoute,
  path: '/'
});

const workspaceRoute = createRoute({
  component: WorkspacePage,
  getParentRoute: () => rootRoute,
  path: '/workspace/$workspaceId'
});

const workspaceSessionRoute = createRoute({
  component: WorkspaceSessionPage,
  getParentRoute: () => rootRoute,
  path: '/workspace/$workspaceId/session/$sessionId'
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  workspaceRoute,
  workspaceSessionRoute
]);

export const router = createRouter({
  routeTree
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
