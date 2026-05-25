import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import type { MessagePart } from '@opencode/shared';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';
import { parseJson } from './server-test-helpers.js';
import { sessionRevertService } from '../services/session/revert-service.js';

const {
  app,
  agentRunService,
  buildSessionCheckpoint,
  environment,
  messageService,
  partService,
  ServiceError,
  sessionEventService,
  sessionInteractionService,
  sessionService,
  workspaceService
} = dbTestContext;

const now = '2026-04-29T13:00:00.000Z';

function createSession() {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });

  return sessionService.createSession({
    goalText: 'Exercise agent routes',
    workspaceId: workspace.id
  });
}

function createActiveRun(sessionId: string) {
  const run = agentRunService.createRun({ sessionId });
  const message = messageService.createMessage({
    content: [],
    role: 'assistant',
    runId: run.id,
    sessionId,
    status: 'running'
  });
  const toolPart: Extract<MessagePart, { type: 'tool' }> = {
    createdAt: now,
    id: 'route-cancel-part',
    messageId: message.id,
    modelToolCallId: 'route-model-call',
    order: 0,
    sessionId,
    state: {
      input: { filePath: 'src/index.ts' },
      status: 'pending'
    },
    toolCallId: 'route-tool-call',
    toolName: 'read',
    type: 'tool',
    updatedAt: now
  };

  partService.createToolPartWithToolCall({
    part: toolPart,
    toolCall: {
      createdAt: now,
      id: toolPart.toolCallId,
      input: toolPart.state.input,
      messageId: toolPart.messageId,
      messagePartId: toolPart.id,
      modelToolCallId: toolPart.modelToolCallId,
      requiresApproval: false,
      runId: run.id,
      sessionId,
      status: 'pending',
      taskId: null,
      toolName: 'read',
      updatedAt: now
    }
  });
  sessionService.updateSessionRuntimeState({
    sessionId,
    status: 'executing'
  });

  return run;
}

beforeEach(() => {
  resetTestDatabase();
});

afterEach(() => {
  mock.restoreAll();
  resetTestDatabase();
});

test('POST /api/sessions/:sessionId/messages delegates to SessionInteractionService and returns 202', async () => {
  const prompt = mock.method(
    sessionInteractionService,
    'prompt',
    async (input: { content: string; sessionId: string }) => {
      assert.deepEqual(input, {
        content: 'Explain the current server structure',
        sessionId: 'session-123'
      });

      return {
        accepted: true,
        message: {
          content: [
            { text: 'Explain the current server structure', type: 'text' }
          ],
          createdAt: '2026-04-21T13:00:00.000Z',
          id: 'message-123',
          kind: 'message',
          role: 'user',
          sessionId: 'session-123'
        }
      };
    }
  );

  const response = await app.request('/api/sessions/session-123/messages', {
    body: JSON.stringify({ content: 'Explain the current server structure' }),
    headers: {
      'content-type': 'application/json'
    },
    method: 'POST'
  });

  assert.equal(response.status, 202);
  assert.equal(prompt.mock.calls.length, 1);

  const payload = await parseJson<{
    accepted: boolean;
    message: { id: string; sessionId: string };
  }>(response);

  assert.equal(payload.data?.accepted, true);
  assert.equal(payload.data?.message.id, 'message-123');
  assert.equal(payload.data?.message.sessionId, 'session-123');
});

test('POST /api/sessions/:sessionId/compact delegates to SessionInteractionService and returns 202', async () => {
  const compact = mock.method(
    sessionInteractionService,
    'manualCompact',
    async (input: { sessionId: string }) => {
      assert.deepEqual(input, { sessionId: 'session-compact' });

      return {
        compacted: true,
        requestMessageId: 'compact-request-1',
        run: {
          createdAt: '2026-05-10T00:00:00.000Z',
          id: 'run-compact-1',
          sessionId: 'session-compact',
          startedAt: '2026-05-10T00:00:00.000Z',
          status: 'completed' as const,
          updatedAt: '2026-05-10T00:00:01.000Z'
        },
        summaryMessageId: 'compact-summary-1'
      };
    }
  );

  const response = await app.request('/api/sessions/session-compact/compact', {
    body: JSON.stringify({}),
    headers: {
      'content-type': 'application/json'
    },
    method: 'POST'
  });

  assert.equal(response.status, 202);
  assert.equal(compact.mock.calls.length, 1);
  const payload = await parseJson<{
    compacted: boolean;
    requestMessageId: string;
    summaryMessageId: string;
  }>(response);

  assert.equal(payload.data?.compacted, true);
  assert.equal(payload.data?.requestMessageId, 'compact-request-1');
  assert.equal(payload.data?.summaryMessageId, 'compact-summary-1');
});

test('POST /api/sessions/:sessionId/revert delegates to SessionRevertService', async () => {
  const revert = mock.method(
    sessionRevertService,
    'revertToMessage',
    async (input: { messageId: string; sessionId: string }) => {
      assert.deepEqual(input, {
        messageId: 'message-123',
        sessionId: 'session-revert'
      });

      return {
        revert: {
          beforeSnapshotId: 'snapshot-before-1',
          createdAt: '2026-05-20T10:00:00.000Z',
          redoSnapshotId: 'snapshot-redo-1',
          targetMessageId: 'message-123'
        },
        session: {
          createdAt: '2026-05-20T09:59:00.000Z',
          defaultVariant: 'plan' as const,
          goalText: 'Exercise revert route',
          id: 'session-revert',
          revert: {
            beforeSnapshotId: 'snapshot-before-1',
            createdAt: '2026-05-20T10:00:00.000Z',
            redoSnapshotId: 'snapshot-redo-1',
            targetMessageId: 'message-123'
          },
          status: 'idle' as const,
          title: 'Exercise revert route',
          updatedAt: '2026-05-20T10:00:01.000Z',
          workspaceId: 'workspace-1'
        }
      };
    }
  );

  const response = await app.request('/api/sessions/session-revert/revert', {
    body: JSON.stringify({ messageId: 'message-123' }),
    headers: {
      'content-type': 'application/json'
    },
    method: 'POST'
  });

  assert.equal(response.status, 200);
  assert.equal(revert.mock.calls.length, 1);
  const payload = await parseJson<{
    revert: { targetMessageId: string };
    session: { id: string };
  }>(response);

  assert.equal(payload.data?.revert.targetMessageId, 'message-123');
  assert.equal(payload.data?.session.id, 'session-revert');
});

test('POST /api/sessions/:sessionId/revert/restore delegates to SessionRevertService', async () => {
  const restoreRevert = mock.method(
    sessionRevertService,
    'restoreRevert',
    async (input: { sessionId: string }) => {
      assert.deepEqual(input, {
        sessionId: 'session-revert'
      });

      return {
        restored: true,
        session: {
          createdAt: '2026-05-20T09:59:00.000Z',
          defaultVariant: 'plan' as const,
          goalText: 'Exercise revert route',
          id: 'session-revert',
          status: 'idle' as const,
          title: 'Exercise revert route',
          updatedAt: '2026-05-20T10:00:02.000Z',
          workspaceId: 'workspace-1'
        }
      };
    }
  );

  const response = await app.request(
    '/api/sessions/session-revert/revert/restore',
    {
      body: JSON.stringify({}),
      headers: {
        'content-type': 'application/json'
      },
      method: 'POST'
    }
  );

  assert.equal(response.status, 200);
  assert.equal(restoreRevert.mock.calls.length, 1);
  const payload = await parseJson<{
    restored: boolean;
    session: { id: string };
  }>(response);

  assert.equal(payload.data?.restored, true);
  assert.equal(payload.data?.session.id, 'session-revert');
});

test('manual compact route does not invoke prompt submission flow', async () => {
  const compact = mock.method(
    sessionInteractionService,
    'manualCompact',
    async () => ({
      compacted: true,
      requestMessageId: 'compact-request-2',
      run: {
        createdAt: '2026-05-10T00:00:00.000Z',
        id: 'run-compact-2',
        sessionId: 'session-compact-2',
        startedAt: '2026-05-10T00:00:00.000Z',
        status: 'completed' as const,
        updatedAt: '2026-05-10T00:00:01.000Z'
      },
      summaryMessageId: 'compact-summary-2'
    })
  );
  const prompt = mock.method(sessionInteractionService, 'prompt', async () => {
    throw new Error('prompt must not be called by manual compact route');
  });

  const response = await app.request(
    '/api/sessions/session-compact-2/compact',
    {
      body: JSON.stringify({}),
      headers: {
        'content-type': 'application/json'
      },
      method: 'POST'
    }
  );

  assert.equal(response.status, 202);
  assert.equal(compact.mock.calls.length, 1);
  assert.equal(prompt.mock.calls.length, 0);
});

test('agent routes map ServiceError instances to HTTP errors', async () => {
  mock.method(sessionInteractionService, 'prompt', async () => {
    throw new ServiceError('Session already has an active run.', 409);
  });
  mock.method(sessionInteractionService, 'resolveApproval', async () => {
    throw new ServiceError('Approval not found: missing-approval', 404);
  });
  mock.method(agentRunService, 'cancelCurrentRun', () => {
    throw new ServiceError('Archived sessions cannot be cancelled.', 409);
  });

  const submitResponse = await app.request(
    '/api/sessions/session-123/messages',
    {
      body: JSON.stringify({ content: 'Trigger a conflict' }),
      headers: {
        'content-type': 'application/json'
      },
      method: 'POST'
    }
  );
  const approvalResponse = await app.request(
    '/api/approvals/missing-approval/approve',
    {
      method: 'POST'
    }
  );
  const cancelResponse = await app.request(
    '/api/sessions/session-123/runs/current/cancel',
    {
      body: JSON.stringify({ reason: 'stop' }),
      headers: {
        'content-type': 'application/json'
      },
      method: 'POST'
    }
  );

  assert.equal(submitResponse.status, 409);
  assert.equal(
    (await parseJson(submitResponse)).error,
    'Session already has an active run.'
  );
  assert.equal(approvalResponse.status, 404);
  assert.equal(
    (await parseJson(approvalResponse)).error,
    'Approval not found: missing-approval'
  );
  assert.equal(cancelResponse.status, 409);
  assert.equal(
    (await parseJson(cancelResponse)).error,
    'Archived sessions cannot be cancelled.'
  );
});

test('POST /api/sessions/:sessionId/runs/current/cancel delegates to AgentRunService', async () => {
  const cancelCurrentRun = mock.method(
    agentRunService,
    'cancelCurrentRun',
    (input: { reason?: string; sessionId: string }) => {
      assert.deepEqual(input, {
        reason: 'user stop',
        sessionId: 'session-cancel'
      });

      return {
        cancelled: false,
        reason: 'no_active_run' as const,
        session: {
          createdAt: '2026-04-21T13:00:00.000Z',
          goalText: 'Cancel route test',
          id: 'session-cancel',
          status: 'idle' as const,
          title: 'Cancel route test',
          updatedAt: '2026-04-21T13:01:00.000Z',
          workspaceId: 'workspace-cancel'
        }
      };
    }
  );

  const response = await app.request(
    '/api/sessions/session-cancel/runs/current/cancel',
    {
      body: JSON.stringify({ reason: 'user stop' }),
      headers: {
        'content-type': 'application/json'
      },
      method: 'POST'
    }
  );

  assert.equal(response.status, 200);
  assert.equal(cancelCurrentRun.mock.calls.length, 1);

  const payload = await parseJson<{
    cancelled: boolean;
    reason: string;
    session: { id: string; status: string };
  }>(response);

  assert.equal(payload.data?.cancelled, false);
  assert.equal(payload.data?.reason, 'no_active_run');
  assert.equal(payload.data?.session.id, 'session-cancel');
  assert.equal(payload.data?.session.status, 'idle');
});

test('POST /api/sessions/:sessionId/runs/current/cancel returns no_active_run without treating it as an error', async () => {
  const session = createSession();
  const response = await app.request(
    `/api/sessions/${session.id}/runs/current/cancel`,
    {
      body: JSON.stringify({}),
      headers: {
        'content-type': 'application/json'
      },
      method: 'POST'
    }
  );

  assert.equal(response.status, 200);

  const payload = await parseJson<{
    cancelled: boolean;
    reason: string;
    session: { id: string; status: string };
  }>(response);

  assert.equal(payload.data?.cancelled, false);
  assert.equal(payload.data?.reason, 'no_active_run');
  assert.equal(payload.data?.session.id, session.id);
  assert.equal(payload.data?.session.status, 'planning');
});

test('POST /api/sessions/:sessionId/runs/current/cancel cancels an active run and replays run events over SSE', async () => {
  const session = createSession();
  const run = createActiveRun(session.id);
  const response = await app.request(
    `/api/sessions/${session.id}/runs/current/cancel`,
    {
      body: JSON.stringify({ reason: 'route stop' }),
      headers: {
        'content-type': 'application/json'
      },
      method: 'POST'
    }
  );

  assert.equal(response.status, 200);

  const payload = await parseJson<{
    cancelled: boolean;
    reason: string;
    run?: { id: string; status: string };
    session: { id: string; status: string };
  }>(response);

  assert.equal(payload.data?.cancelled, true);
  assert.equal(payload.data?.reason, 'active_run_cancelled');
  assert.equal(payload.data?.run?.id, run.id);
  assert.equal(payload.data?.run?.status, 'cancelled');
  assert.equal(payload.data?.session.status, 'idle');

  const replay = sessionEventService.listAfterSequence(session.id, 0);

  assert.ok(replay.some((envelope) => envelope.event.type === 'run.cancelled'));
  assert.ok(
    replay.some((envelope) => envelope.event.type === 'session.updated')
  );
});

test('approval routes delegate approve and reject decisions to SessionInteractionService', async () => {
  const decisions: Array<{ approvalId: string; decision: string }> = [];

  mock.method(
    sessionInteractionService,
    'resolveApproval',
    async (input: {
      approvalId: string;
      decision: 'approved' | 'rejected';
    }) => {
      decisions.push(input);

      return {
        approval: {
          createdAt: '2026-04-21T13:05:00.000Z',
          id: input.approvalId,
          kind: 'bash',
          payload: {},
          sessionId: 'session-approval',
          status: input.decision,
          toolCallId: 'tool-approval'
        },
        toolCall: {
          createdAt: '2026-04-21T13:05:00.000Z',
          id: 'tool-approval',
          input: {},
          sessionId: 'session-approval',
          status: input.decision === 'approved' ? 'approved' : 'rejected',
          toolName: 'bash',
          updatedAt: '2026-04-21T13:05:30.000Z'
        }
      };
    }
  );

  const approveResponse = await app.request(
    '/api/approvals/approval-1/approve',
    {
      method: 'POST'
    }
  );
  const rejectResponse = await app.request('/api/approvals/approval-1/reject', {
    method: 'POST'
  });

  assert.equal(approveResponse.status, 200);
  assert.equal(rejectResponse.status, 200);
  assert.deepEqual(decisions, [
    { approvalId: 'approval-1', decision: 'approved' },
    { approvalId: 'approval-1', decision: 'rejected' }
  ]);
});

test('GET /api/sessions/:sessionId/stream replays events after Last-Event-ID', async () => {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });
  const session = sessionService.createSession({
    goalText: 'Replay events after the last seen sequence number',
    workspaceId: workspace.id
  });

  sessionEventService.append({
    sessionId: session.id,
    type: 'session.updated',
    updatedAt: '2026-04-21T13:10:00.000Z'
  });

  const replayedEnvelope = sessionEventService.append({
    checkpoint: buildSessionCheckpoint({
      kind: 'waiting_approval',
      updatedAt: '2026-04-21T13:10:30.000Z'
    }),
    sessionId: session.id,
    type: 'session.resumable'
  });

  const abortController = new AbortController();
  const response = await app.request(`/api/sessions/${session.id}/stream`, {
    headers: {
      'Last-Event-ID': '1'
    },
    signal: abortController.signal
  });

  assert.equal(response.status, 200);
  assert.ok(response.body);

  const reader = response.body.getReader();
  const { done, value } = await reader.read();

  assert.equal(done, false);

  const chunk = new TextDecoder().decode(value);
  const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));

  assert.ok(dataLine);

  const replayedPayload = JSON.parse(dataLine.slice(6)) as {
    createdAt: string;
    event: { type: string };
    sequenceNo: number;
  };

  assert.equal(replayedPayload.sequenceNo, replayedEnvelope.sequenceNo);
  assert.equal(replayedPayload.event.type, 'session.resumable');
  assert.equal(replayedPayload.createdAt, replayedEnvelope.createdAt);

  abortController.abort();

  try {
    await reader.cancel();
  } catch {
    // The stream can already be closed by the abort signal.
  }
});
