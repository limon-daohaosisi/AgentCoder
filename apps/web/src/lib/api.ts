import type {
  AgentRunDto,
  WorkspaceDirectoryBrowseDto,
  CancelRunInput,
  CancelRunResponse,
  CreateSessionInput,
  CreateWorkspaceInput,
  MessageDto,
  RestoreRevertResponse,
  RevertSessionResponse,
  ResumeSessionDto,
  SessionDto,
  SessionPlanBoardDto,
  SessionPlanFileDto,
  SubmitSessionMessageInput,
  SubmitSessionMessageResponse,
  WorkspaceDto
} from '@opencode/shared';

type ApiEnvelope<T> = {
  data: T;
};

type ApiErrorPayload = {
  error?: string;
  issues?: unknown;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const API_BASE_PATH = '/api';

export async function fetchJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit
) {
  const response = await fetch(input, init);
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? ((await response.json()) as ApiErrorPayload | T)
    : undefined;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorPayload | undefined;

    throw new ApiError(
      errorPayload?.error ?? `Request failed: ${response.status}`,
      response.status,
      errorPayload?.issues
    );
  }

  return payload as T;
}

async function fetchData<T>(path: string, init?: RequestInit) {
  const payload = await fetchJson<ApiEnvelope<T>>(
    `${API_BASE_PATH}${path}`,
    init
  );
  return payload.data;
}

export function listWorkspaces() {
  return fetchData<WorkspaceDto[]>('/workspaces');
}

export function browseWorkspaceDirectory(path?: string) {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';

  return fetchData<WorkspaceDirectoryBrowseDto>(`/workspaces/browse${query}`);
}

export function createWorkspace(input: CreateWorkspaceInput) {
  return fetchData<WorkspaceDto>('/workspaces', {
    body: JSON.stringify(input),
    headers: {
      'content-type': 'application/json'
    },
    method: 'POST'
  });
}

export function listSessions(workspaceId: string) {
  return fetchData<SessionDto[]>(
    `/sessions?workspaceId=${encodeURIComponent(workspaceId)}`
  );
}

export function createSession(input: CreateSessionInput) {
  return fetchData<SessionDto>('/sessions', {
    body: JSON.stringify(input),
    headers: {
      'content-type': 'application/json'
    },
    method: 'POST'
  });
}

export function getSession(sessionId: string) {
  return fetchData<SessionDto>(`/sessions/${sessionId}`);
}

export function getSessionPlanBoard(sessionId: string) {
  return fetchData<SessionPlanBoardDto>(`/sessions/${sessionId}/plan-board`);
}

export function getSessionPlanFile(sessionId: string) {
  return fetchData<SessionPlanFileDto>(`/sessions/${sessionId}/plan-file`);
}

export function listMessages(sessionId: string) {
  return fetchData<MessageDto[]>(`/sessions/${sessionId}/messages`);
}

export function revertSession(sessionId: string, input: { messageId: string }) {
  return fetchData<RevertSessionResponse>(`/sessions/${sessionId}/revert`, {
    body: JSON.stringify(input),
    headers: {
      'content-type': 'application/json'
    },
    method: 'POST'
  });
}

export function restoreRevert(sessionId: string) {
  return fetchData<RestoreRevertResponse>(
    `/sessions/${sessionId}/revert/restore`,
    {
      body: JSON.stringify({}),
      headers: {
        'content-type': 'application/json'
      },
      method: 'POST'
    }
  );
}

export function resumeSession(sessionId: string) {
  return fetchData<ResumeSessionDto>(`/sessions/${sessionId}/resume`, {
    method: 'POST'
  });
}

export function submitSessionMessage(
  sessionId: string,
  input: SubmitSessionMessageInput
) {
  return fetchData<SubmitSessionMessageResponse>(
    `/sessions/${sessionId}/messages`,
    {
      body: JSON.stringify(input),
      headers: {
        'content-type': 'application/json'
      },
      method: 'POST'
    }
  );
}

export function manualCompact(sessionId: string) {
  return fetchData<{
    compacted: true;
    postContextMessageId?: string;
    requestMessageId: string;
    run: AgentRunDto;
    summaryMessageId: string;
  }>(`/sessions/${sessionId}/compact`, {
    body: JSON.stringify({}),
    headers: {
      'content-type': 'application/json'
    },
    method: 'POST'
  });
}

export function cancelCurrentRun(
  sessionId: string,
  input: CancelRunInput = {}
) {
  return fetchData<CancelRunResponse>(
    `/sessions/${sessionId}/runs/current/cancel`,
    {
      body: JSON.stringify(input),
      headers: {
        'content-type': 'application/json'
      },
      method: 'POST'
    }
  );
}

export function approveApproval(approvalId: string) {
  return fetchData<{ approvalId: string } | { approval: unknown }>(
    `/approvals/${approvalId}/approve`,
    {
      method: 'POST'
    }
  );
}

export function rejectApproval(approvalId: string) {
  return fetchData<{ approvalId: string } | { approval: unknown }>(
    `/approvals/${approvalId}/reject`,
    {
      method: 'POST'
    }
  );
}
