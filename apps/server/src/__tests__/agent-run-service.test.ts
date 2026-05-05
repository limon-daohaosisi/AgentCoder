import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { MessagePart } from '@opencode/shared';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';
import { agentRunRepository } from '../repositories/agent-run-repository.js';
import { approvalRepository } from '../repositories/approval-repository.js';
import { messagePartRepository } from '../repositories/message-part-repository.js';
import { messageRepository } from '../repositories/message-repository.js';
import { toolCallRepository } from '../repositories/tool-call-repository.js';

const {
  agentRunService,
  buildSessionCheckpoint,
  environment,
  messageService,
  partService,
  sessionEventService,
  sessionService,
  workspaceService
} = dbTestContext;

const now = '2026-04-29T12:00:00.000Z';

beforeEach(() => {
  resetTestDatabase();
});

function createSession() {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });

  return sessionService.createSession({
    goalText: 'Exercise agent run cancellation',
    workspaceId: workspace.id
  });
}

function createRunningFixture() {
  const session = createSession();
  const run = agentRunService.createRun({ sessionId: session.id });
  const userMessage = messageService.createMessage({
    content: [{ text: 'Start work', type: 'text' }],
    role: 'user',
    runId: run.id,
    sessionId: session.id
  });
  const assistantMessage = messageService.createMessage({
    content: [],
    role: 'assistant',
    runId: run.id,
    sessionId: session.id,
    status: 'running'
  });
  const toolPart: Extract<MessagePart, { type: 'tool' }> = {
    createdAt: now,
    id: 'part-running-tool',
    messageId: assistantMessage.id,
    modelToolCallId: 'model-call-running-tool',
    order: 0,
    sessionId: session.id,
    state: {
      input: { path: 'src/index.ts' },
      status: 'pending'
    },
    toolCallId: 'tool-call-running-tool',
    toolName: 'read_file',
    type: 'tool',
    updatedAt: now
  };
  const createdTool = partService.createToolPartWithToolCall({
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
      sessionId: session.id,
      status: 'pending',
      taskId: null,
      toolName: 'read_file',
      updatedAt: now
    }
  });

  agentRunService.setTriggerMessage({
    runId: run.id,
    triggerMessageId: userMessage.id
  });
  sessionService.updateSessionRuntimeState({
    lastErrorText: 'previous error',
    sessionId: session.id,
    status: 'executing'
  });

  return { assistantMessage, createdTool, run, session, userMessage };
}

function createWaitingApprovalFixture() {
  const fixture = createRunningFixture();
  const { run, session } = fixture;
  const assistantMessage = messageService.createMessage({
    content: [],
    role: 'assistant',
    runId: run.id,
    sessionId: session.id,
    status: 'completed'
  });
  const toolPart: Extract<MessagePart, { type: 'tool' }> = {
    createdAt: now,
    id: 'part-approval-tool',
    messageId: assistantMessage.id,
    modelToolCallId: 'model-call-approval-tool',
    order: 0,
    sessionId: session.id,
    state: {
      input: { command: 'pwd' },
      status: 'pending'
    },
    toolCallId: 'tool-call-approval-tool',
    toolName: 'run_command',
    type: 'tool',
    updatedAt: now
  };
  const createdTool = partService.createToolPartWithToolCall({
    part: toolPart,
    toolCall: {
      createdAt: now,
      id: toolPart.toolCallId,
      input: toolPart.state.input,
      messageId: toolPart.messageId,
      messagePartId: toolPart.id,
      modelToolCallId: toolPart.modelToolCallId,
      requiresApproval: true,
      runId: run.id,
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
    id: 'approval-cancel-test',
    kind: 'run_command',
    payload: {},
    runId: run.id,
    sessionId: session.id,
    status: 'pending',
    suggestedRuleJson: null,
    taskId: null,
    toolCallId: createdTool.toolCall.id
  });
  const checkpoint = buildSessionCheckpoint({
    approvalId: approval.id,
    kind: 'waiting_approval',
    messageId: assistantMessage.id,
    modelToolCallId: toolPart.modelToolCallId,
    partId: toolPart.id,
    toolCallId: toolPart.toolCallId,
    updatedAt: now
  });

  agentRunService.markWaitingApproval({ checkpoint, runId: run.id });
  sessionService.updateSessionRuntimeState({
    lastCheckpoint: checkpoint,
    sessionId: session.id,
    status: 'waiting_approval'
  });

  return { ...fixture, approval, approvalTool: createdTool, checkpoint };
}

test('cancelCurrentRun finalizes open running state and returns session to idle', () => {
  const { assistantMessage, createdTool, run, session } =
    createRunningFixture();
  const response = agentRunService.cancelCurrentRun({
    reason: 'Stop current run',
    sessionId: session.id
  });

  assert.equal(response.cancelled, true);
  assert.equal(response.reason, 'active_run_cancelled');
  assert.equal(response.run?.status, 'cancelled');
  assert.equal(response.session.status, 'idle');
  assert.equal(response.session.lastCheckpointJson, undefined);
  assert.equal(response.session.lastErrorText, undefined);

  const cancelledRun = agentRunRepository.getById(run.id);
  const cancelledMessage = messageRepository.getById(assistantMessage.id);
  const interruptedPart = messagePartRepository.getById(createdTool.part.id);
  const failedToolCall = toolCallRepository.getById(createdTool.toolCall.id);

  assert.equal(cancelledRun?.status, 'cancelled');
  assert.equal(cancelledRun?.errorText, 'Stop current run');
  assert.equal(cancelledMessage?.status, 'cancelled');
  assert.equal(cancelledMessage?.finishReason, 'cancelled');
  assert.equal(interruptedPart?.type, 'tool');
  assert.equal(
    interruptedPart?.type === 'tool' ? interruptedPart.state.status : undefined,
    'error'
  );
  assert.equal(
    interruptedPart?.type === 'tool' && interruptedPart.state.status === 'error'
      ? interruptedPart.state.reason
      : undefined,
    'interrupted'
  );
  assert.equal(failedToolCall?.status, 'failed');
  assert.equal(failedToolCall?.errorText, 'Stop current run');

  assert.deepEqual(
    sessionEventService
      .listAfterSequence(session.id, 0)
      .map((envelope) => envelope.event.type),
    ['message.cancelled', 'tool.failed', 'run.cancelled', 'session.updated']
  );
});

test('cancelCurrentRun rejects pending approval and remains idempotent', () => {
  const { approval, approvalTool, run, session } =
    createWaitingApprovalFixture();
  const response = agentRunService.cancelCurrentRun({ sessionId: session.id });

  assert.equal(response.cancelled, true);
  assert.equal(response.reason, 'approval_cancelled');
  assert.equal(response.session.status, 'idle');

  const rejectedApproval = approvalRepository.getById(approval.id);
  const interruptedPart = messagePartRepository.getById(approvalTool.part.id);
  const failedToolCall = toolCallRepository.getById(approvalTool.toolCall.id);

  assert.equal(rejectedApproval?.status, 'rejected');
  assert.equal(rejectedApproval?.decisionReasonText, 'Run cancelled by user');
  assert.ok(rejectedApproval?.decidedAt);
  assert.equal(interruptedPart?.type, 'tool');
  assert.equal(
    interruptedPart?.type === 'tool' ? interruptedPart.state.status : undefined,
    'error'
  );
  assert.equal(failedToolCall?.status, 'failed');

  const secondResponse = agentRunService.cancelCurrentRun({
    sessionId: session.id
  });

  assert.equal(secondResponse.cancelled, false);
  assert.equal(secondResponse.reason, 'no_active_run');
  assert.equal(agentRunRepository.getById(run.id)?.status, 'cancelled');

  assert.deepEqual(
    sessionEventService
      .listAfterSequence(session.id, 0)
      .map((envelope) => envelope.event.type),
    [
      'approval.resolved',
      'message.cancelled',
      'tool.failed',
      'tool.failed',
      'run.cancelled',
      'session.updated'
    ]
  );
});

test('cancelCurrentRun does not clean up or overwrite a completed run race', () => {
  const { assistantMessage, createdTool, run, session } =
    createRunningFixture();

  agentRunService.markCompleted({ runId: run.id });

  const response = agentRunService.cancelCurrentRun({ sessionId: session.id });

  assert.equal(response.cancelled, false);
  assert.equal(response.reason, 'no_active_run');
  assert.equal(agentRunRepository.getById(run.id)?.status, 'completed');
  assert.equal(
    messageRepository.getById(assistantMessage.id)?.status,
    'running'
  );
  assert.equal(
    messagePartRepository.getById(createdTool.part.id)?.type === 'tool'
      ? (
          messagePartRepository.getById(createdTool.part.id) as Extract<
            MessagePart,
            { type: 'tool' }
          >
        ).state.status
      : undefined,
    'pending'
  );
  assert.equal(
    toolCallRepository.getById(createdTool.toolCall.id)?.status,
    'pending'
  );
  assert.deepEqual(sessionEventService.listAfterSequence(session.id, 0), []);
});
