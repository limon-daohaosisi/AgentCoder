import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { sessionStreamHub } from '../lib/session-stream-hub.js';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';

const {
  agentRunService,
  buildSessionCheckpoint,
  environment,
  messageService,
  sessionEventService,
  sessionService,
  sqlite,
  workspaceService
} = dbTestContext;

beforeEach(() => {
  resetTestDatabase();
});

test('sessionEventService persists ordered envelopes and publishes them to subscribers', () => {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });
  const session = sessionService.createSession({
    goalText: 'Exercise session event service',
    workspaceId: workspace.id
  });
  const subscription = sessionStreamHub.subscribe(session.id);
  const firstEnvelope = sessionEventService.append({
    sessionId: session.id,
    type: 'session.updated',
    updatedAt: '2026-04-21T12:00:00.000Z'
  });
  const secondEnvelope = sessionEventService.append({
    error: 'Tool failed',
    sessionId: session.id,
    toolCallId: 'tool-2',
    type: 'tool.failed'
  });

  assert.equal(firstEnvelope.sequenceNo, 1);
  assert.equal(secondEnvelope.sequenceNo, 2);
  assert.deepEqual(subscription.drain(), [firstEnvelope, secondEnvelope]);
  assert.deepEqual(sessionEventService.listAfterSequence(session.id, 1), [
    secondEnvelope
  ]);

  subscription.unsubscribe();
});

test('sessionEventService uses checkpoint.updatedAt for resumable events', () => {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });
  const session = sessionService.createSession({
    goalText: 'Resume from checkpoint timestamp',
    workspaceId: workspace.id
  });
  const checkpoint = buildSessionCheckpoint({
    approvalId: 'approval-2',
    kind: 'waiting_approval',
    updatedAt: '2026-04-21T12:05:00.000Z'
  });
  const envelope = sessionEventService.append({
    checkpoint,
    sessionId: session.id,
    type: 'session.resumable'
  });

  assert.equal(envelope.createdAt, '2026-04-21T12:05:00.000Z');
  assert.equal(envelope.event.type, 'session.resumable');
});

test('sessionEventService persists derived run ids for run-owned events', () => {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });
  const session = sessionService.createSession({
    goalText: 'Persist run id on events',
    workspaceId: workspace.id
  });
  const run = agentRunService.createRun({ sessionId: session.id });
  const message = messageService.createMessage({
    content: [{ text: 'hello', type: 'text' }],
    role: 'user',
    runId: run.id,
    sessionId: session.id
  });
  const envelope = sessionEventService.append({
    message,
    sessionId: session.id,
    type: 'message.created'
  });

  const row = sqlite
    .prepare('SELECT run_id FROM session_events WHERE id = ?')
    .get(`${session.id}:${envelope.sequenceNo}`) as
    | { run_id: null | string }
    | undefined;

  assert.equal(row?.run_id, run.id);
});

test('sessionEventService persists derived run ids for message part events', () => {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });
  const session = sessionService.createSession({
    goalText: 'Persist run id on message part events',
    workspaceId: workspace.id
  });
  const run = agentRunService.createRun({ sessionId: session.id });
  const message = messageService.createMessage({
    content: [{ text: 'hello', type: 'text' }],
    role: 'assistant',
    runId: run.id,
    sessionId: session.id
  });
  const part = message.content[0]!;
  const envelope = sessionEventService.append({
    messageId: message.id,
    part,
    runId: run.id,
    sessionId: session.id,
    type: 'message.part.created'
  });

  const row = sqlite
    .prepare('SELECT run_id FROM session_events WHERE id = ?')
    .get(`${session.id}:${envelope.sequenceNo}`) as
    | { run_id: null | string }
    | undefined;

  assert.equal(row?.run_id, run.id);
});
