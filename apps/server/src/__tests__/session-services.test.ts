import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { MessagePart } from '@opencode/shared';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';
import { approvalRepository } from '../repositories/approval-repository.js';

const {
  buildSessionCheckpoint,
  environment,
  messageService,
  partService,
  sessionService,
  workspaceService
} = dbTestContext;

beforeEach(() => {
  resetTestDatabase();
});

test('messageService persists and updates messages while sessionService stores runtime state', () => {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });
  const session = sessionService.createSession({
    goalText: 'Exercise message + session services',
    workspaceId: workspace.id
  });
  const message = messageService.createMessage({
    content: [{ text: 'Initial content', type: 'text' }],
    role: 'user',
    sessionId: session.id
  });
  const checkpoint = buildSessionCheckpoint({
    kind: 'waiting_approval',
    messageId: message.id,
    modelToolCallId: 'model-tool-123',
    partId: message.content[0]?.id,
    toolCallId: 'tool-123',
    updatedAt: '2026-04-21T11:00:00.000Z'
  });

  assert.equal(message.content[0]?.type, 'text');
  assert.equal(
    message.content[0]?.type === 'text' ? message.content[0].text : undefined,
    'Initial content'
  );
  assert.deepEqual(
    messageService.listMessages(session.id).map((item) => item.id),
    [message.id]
  );

  const updatedPart =
    message.content[0]?.type === 'text'
      ? partService.updatePart({
          ...message.content[0],
          text: 'Updated content'
        })
      : null;
  const updatedMessage = messageService.listMessages(session.id)[0];

  assert.equal(updatedPart?.type, 'text');
  assert.equal(updatedMessage?.content[0]?.type, 'text');
  assert.equal(
    updatedMessage?.content[0]?.type === 'text'
      ? updatedMessage.content[0].text
      : undefined,
    'Updated content'
  );

  const updatedSession = sessionService.updateSessionRuntimeState({
    lastCheckpoint: checkpoint,
    lastErrorText: 'Waiting for user approval',
    sessionId: session.id,
    status: 'waiting_approval'
  });

  assert.equal(updatedSession?.status, 'waiting_approval');
  assert.equal(updatedSession?.lastErrorText, 'Waiting for user approval');
  assert.equal(updatedSession?.lastCheckpointJson, JSON.stringify(checkpoint));

  const resumePayload = sessionService.resumeSession(session.id);

  assert.equal(resumePayload.canResume, false);
  assert.equal(resumePayload.checkpoint, JSON.stringify(checkpoint));
});

test('sessionService only resumes approval checkpoints with a pending ToolPart', () => {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });
  const session = sessionService.createSession({
    goalText: 'Validate approval resume state',
    workspaceId: workspace.id
  });
  const now = '2026-04-27T00:00:00.000Z';
  const assistant = messageService.createMessage({
    content: [],
    role: 'assistant',
    sessionId: session.id,
    status: 'completed'
  });
  const toolPart: Extract<MessagePart, { type: 'tool' }> = {
    createdAt: now,
    id: 'part-tool-resume',
    messageId: assistant.id,
    modelToolCallId: 'model-call-resume',
    order: 0,
    sessionId: session.id,
    state: {
      input: { command: 'pwd' },
      status: 'pending'
    },
    toolCallId: 'tool-call-resume',
    toolName: 'run_command',
    type: 'tool',
    updatedAt: now
  };
  const created = partService.createToolPartWithToolCall({
    part: toolPart,
    toolCall: {
      createdAt: now,
      id: toolPart.toolCallId,
      input: toolPart.state.input,
      messageId: toolPart.messageId,
      messagePartId: toolPart.id,
      modelToolCallId: toolPart.modelToolCallId,
      requiresApproval: true,
      sessionId: session.id,
      status: 'pending_approval',
      taskId: null,
      toolName: 'run_command',
      updatedAt: now
    }
  });
  const approval = approvalRepository.create({
    createdAt: now,
    decisionReasonText: null,
    decidedAt: null,
    decidedBy: null,
    decisionScope: 'once',
    id: 'approval-resume',
    kind: 'run_command',
    payload: {},
    sessionId: session.id,
    status: 'pending',
    suggestedRuleJson: null,
    taskId: null,
    toolCallId: created.toolCall.id
  });
  const checkpoint = buildSessionCheckpoint({
    approvalId: approval.id,
    kind: 'waiting_approval',
    messageId: assistant.id,
    modelToolCallId: toolPart.modelToolCallId,
    partId: toolPart.id,
    toolCallId: toolPart.toolCallId,
    updatedAt: now
  });

  sessionService.updateSessionRuntimeState({
    lastCheckpoint: checkpoint,
    sessionId: session.id,
    status: 'waiting_approval'
  });

  assert.equal(sessionService.resumeSession(session.id).canResume, true);

  partService.updateToolPartWithToolCall({
    part: {
      ...created.part,
      state: {
        completedAt: now,
        errorText: 'Already handled',
        input: toolPart.state.input,
        reason: 'interrupted',
        status: 'error'
      }
    },
    toolCall: {
      completedAt: now,
      errorText: 'Already handled',
      id: created.toolCall.id,
      result: { error: 'Already handled', ok: false },
      status: 'failed',
      updatedAt: now
    }
  });

  assert.equal(sessionService.resumeSession(session.id).canResume, false);
});

test('messageService rejects writes for missing sessions', () => {
  assert.throws(
    () =>
      messageService.createMessage({
        content: [{ text: 'Should fail', type: 'text' }],
        role: 'assistant',
        sessionId: 'missing-session'
      }),
    /Session not found: missing-session/
  );
});
