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
  sessionRecoveryService,
  sessionService,
  workspaceService
} = dbTestContext;

const now = '2026-05-06T08:00:00.000Z';

beforeEach(() => {
  resetTestDatabase();
});

function createSession() {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });

  return sessionService.createSession({
    goalText: 'Exercise startup recovery',
    workspaceId: workspace.id
  });
}

function createRunningRecoveryFixture(session = createSession()) {
  const run = agentRunService.createRun({ sessionId: session.id });
  const userMessage = messageService.createMessage({
    content: [{ text: 'Do work', type: 'text' }],
    createdAt: now,
    role: 'user',
    runId: run.id,
    sessionId: session.id
  });
  const assistantMessage = messageService.createMessage({
    content: [],
    createdAt: now,
    role: 'assistant',
    runId: run.id,
    sessionId: session.id,
    status: 'running'
  });
  const toolPart: Extract<MessagePart, { type: 'tool' }> = {
    createdAt: now,
    id: `part-${run.id}`,
    messageId: assistantMessage.id,
    modelToolCallId: `model-${run.id}`,
    order: 0,
    sessionId: session.id,
    state: {
      input: { path: 'src/index.ts' },
      status: 'pending'
    },
    toolCallId: `tool-${run.id}`,
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
      messageId: assistantMessage.id,
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
    sessionId: session.id,
    status: 'executing'
  });

  return { assistantMessage, createdTool, run, session };
}

function createWaitingApprovalFixture() {
  const session = createSession();
  const run = agentRunService.createRun({ sessionId: session.id });
  const assistantMessage = messageService.createMessage({
    content: [],
    createdAt: now,
    role: 'assistant',
    runId: run.id,
    sessionId: session.id,
    status: 'completed'
  });
  const toolPart: Extract<MessagePart, { type: 'tool' }> = {
    createdAt: now,
    id: `approval-part-${run.id}`,
    messageId: assistantMessage.id,
    modelToolCallId: `approval-model-${run.id}`,
    order: 0,
    sessionId: session.id,
    state: {
      input: { command: 'pwd' },
      status: 'pending'
    },
    toolCallId: `approval-tool-${run.id}`,
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
    id: `approval-${run.id}`,
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

  return { approval, checkpoint, createdTool, run, session, toolPart };
}

test('startup recovery keeps valid waiting approval sessions resumable', () => {
  const { approval, createdTool, run, session, toolPart } =
    createWaitingApprovalFixture();

  const report = sessionRecoveryService.recoverInterruptedSessionsOnStartup();

  assert.equal(report.waitingApprovalsKept, 1);
  assert.equal(report.blockedRuns, 0);
  assert.equal(report.blockedSessions, 0);
  assert.equal(
    sessionService.getSession(session.id)?.status,
    'waiting_approval'
  );
  assert.equal(agentRunRepository.getById(run.id)?.status, 'waiting_approval');
  assert.equal(approvalRepository.getById(approval.id)?.status, 'pending');
  assert.equal(
    toolCallRepository.getById(createdTool.toolCall.id)?.status,
    'pending_approval'
  );
  const recoveredToolPart = messagePartRepository.getById(toolPart.id);
  assert.equal(
    recoveredToolPart?.type === 'tool'
      ? recoveredToolPart.state.status
      : undefined,
    'pending'
  );
  assert.deepEqual(
    sessionEventService
      .listAfterSequence(session.id, 0)
      .map((envelope) => envelope.event.type),
    ['session.recovered', 'session.updated']
  );
});

test('startup recovery blocks invalid waiting approval checkpoints and preserves session checkpoint', () => {
  const { approval, checkpoint, createdTool, run, session } =
    createWaitingApprovalFixture();
  toolCallRepository.update({
    id: createdTool.toolCall.id,
    status: 'pending',
    updatedAt: '2026-05-06T08:01:00.000Z'
  });

  const report = sessionRecoveryService.recoverInterruptedSessionsOnStartup();

  assert.equal(report.blockedRuns, 1);
  assert.equal(report.blockedSessions, 1);
  assert.equal(sessionService.getSession(session.id)?.status, 'blocked');
  assert.equal(agentRunRepository.getById(run.id)?.status, 'blocked');
  assert.equal(
    sessionService.getSession(session.id)?.lastCheckpointJson,
    JSON.stringify(checkpoint)
  );
  assert.equal(approvalRepository.getById(approval.id)?.status, 'pending');
  assert.match(
    sessionService.getSession(session.id)?.lastErrorText ?? '',
    /Invalid waiting approval checkpoint during startup recovery\./u
  );
  assert.deepEqual(
    sessionEventService
      .listAfterSequence(session.id, 0)
      .map((envelope) => envelope.event.type),
    ['run.blocked', 'session.recovered', 'session.updated']
  );
});

test('startup recovery rejects keeping waiting approval when session has extra pending approvals', () => {
  const { run, session } = createWaitingApprovalFixture();
  const extraRun = agentRunService.createRun({ sessionId: session.id });
  const extraAssistantMessage = messageService.createMessage({
    content: [],
    createdAt: now,
    role: 'assistant',
    runId: extraRun.id,
    sessionId: session.id,
    status: 'completed'
  });
  const extraToolPart: Extract<MessagePart, { type: 'tool' }> = {
    createdAt: now,
    id: `extra-part-${extraRun.id}`,
    messageId: extraAssistantMessage.id,
    modelToolCallId: `extra-model-${extraRun.id}`,
    order: 0,
    sessionId: session.id,
    state: {
      input: { command: 'pwd' },
      status: 'pending'
    },
    toolCallId: `extra-tool-${extraRun.id}`,
    toolName: 'run_command',
    type: 'tool',
    updatedAt: now
  };
  const extraTool = partService.createToolPartWithToolCall({
    part: extraToolPart,
    toolCall: {
      createdAt: now,
      id: extraToolPart.toolCallId,
      input: extraToolPart.state.input,
      messageId: extraToolPart.messageId,
      messagePartId: extraToolPart.id,
      modelToolCallId: extraToolPart.modelToolCallId,
      requiresApproval: true,
      runId: extraRun.id,
      sessionId: session.id,
      status: 'pending_approval',
      taskId: null,
      toolName: 'run_command',
      updatedAt: now
    }
  });

  approvalRepository.create({
    createdAt: now,
    decisionReasonText: null,
    decidedAt: null,
    decidedBy: null,
    decisionScope: 'once',
    id: `extra-approval-${extraRun.id}`,
    kind: 'run_command',
    payload: {},
    runId: extraRun.id,
    sessionId: session.id,
    status: 'pending',
    suggestedRuleJson: null,
    taskId: null,
    toolCallId: extraTool.toolCall.id
  });

  const report = sessionRecoveryService.recoverInterruptedSessionsOnStartup();

  assert.equal(report.blockedRuns, 2);
  assert.equal(report.waitingApprovalsKept, 0);
  assert.equal(report.blockedSessions, 1);
  assert.equal(sessionService.getSession(session.id)?.status, 'blocked');
  assert.equal(agentRunRepository.getById(run.id)?.status, 'blocked');
  assert.equal(agentRunRepository.getById(extraRun.id)?.status, 'blocked');
  assert.match(
    sessionService.getSession(session.id)?.lastErrorText ?? '',
    /Expected one pending approval, found 2\./u
  );
});

test('startup recovery converges interrupted running runs to blocked run and idle session', () => {
  const { assistantMessage, createdTool, run, session } =
    createRunningRecoveryFixture();

  const report = sessionRecoveryService.recoverInterruptedSessionsOnStartup();

  assert.equal(report.interruptedRuns, 1);
  assert.equal(report.blockedRuns, 1);
  assert.equal(sessionService.getSession(session.id)?.status, 'idle');
  assert.equal(agentRunRepository.getById(run.id)?.status, 'blocked');
  assert.equal(
    messageRepository.getById(assistantMessage.id)?.status,
    'cancelled'
  );
  assert.equal(
    toolCallRepository.getById(createdTool.toolCall.id)?.status,
    'failed'
  );
  const recoveredPart = messagePartRepository.getById(createdTool.part.id);
  assert.equal(recoveredPart?.type, 'tool');
  assert.equal(
    recoveredPart?.type === 'tool' ? recoveredPart.state.status : undefined,
    'error'
  );
  assert.equal(
    recoveredPart?.type === 'tool' && recoveredPart.state.status === 'error'
      ? recoveredPart.state.reason
      : undefined,
    'interrupted'
  );
  assert.match(
    sessionService.getSession(session.id)?.lastErrorText ?? '',
    /Previous run was interrupted by server restart\./u
  );
  assert.deepEqual(
    sessionEventService
      .listAfterSequence(session.id, 0)
      .map((envelope) => envelope.event.type),
    [
      'message.cancelled',
      'tool.failed',
      'run.blocked',
      'session.recovered',
      'session.updated'
    ]
  );
});

test('startup recovery resets stale executing sessions without open runs', () => {
  const session = createSession();

  sessionService.updateSessionRuntimeState({
    lastCheckpoint: buildSessionCheckpoint({
      kind: 'waiting_approval',
      updatedAt: now
    }),
    sessionId: session.id,
    status: 'executing'
  });

  const report = sessionRecoveryService.recoverInterruptedSessionsOnStartup();

  assert.equal(report.staleExecutingSessions, 1);
  assert.equal(sessionService.getSession(session.id)?.status, 'idle');
  assert.equal(
    sessionService.getSession(session.id)?.lastCheckpointJson,
    undefined
  );
  assert.match(
    sessionService.getSession(session.id)?.lastErrorText ?? '',
    /stale_executing_session/u
  );
  assert.deepEqual(
    sessionEventService
      .listAfterSequence(session.id, 0)
      .map((envelope) => envelope.event.type),
    ['session.recovered', 'session.updated']
  );
});

test('startup recovery records multiple_open_runs diagnostics and converges all interrupted runs', () => {
  const session = createSession();
  const firstRun = createRunningRecoveryFixture(session);
  const secondRun = createRunningRecoveryFixture(session);

  const report = sessionRecoveryService.recoverInterruptedSessionsOnStartup();
  const recoveredSession = sessionService.getSession(session.id);

  assert.equal(report.multipleOpenRunSessions, 1);
  assert.equal(report.interruptedRuns, 2);
  assert.equal(recoveredSession?.status, 'idle');
  assert.match(recoveredSession?.lastErrorText ?? '', /multiple_open_runs/u);
  assert.equal(agentRunRepository.getById(firstRun.run.id)?.status, 'blocked');
  assert.equal(agentRunRepository.getById(secondRun.run.id)?.status, 'blocked');
});

test('startup recovery blocks stale waiting approval sessions without open runs', () => {
  const session = createSession();
  const checkpoint = buildSessionCheckpoint({
    approvalId: 'missing-approval',
    kind: 'waiting_approval',
    messageId: 'missing-message',
    modelToolCallId: 'missing-tool-call',
    partId: 'missing-part',
    toolCallId: 'missing-tool',
    updatedAt: now
  });

  sessionService.updateSessionRuntimeState({
    lastCheckpoint: checkpoint,
    sessionId: session.id,
    status: 'waiting_approval'
  });

  const report = sessionRecoveryService.recoverInterruptedSessionsOnStartup();

  assert.equal(report.blockedSessions, 1);
  assert.equal(sessionService.getSession(session.id)?.status, 'blocked');
  assert.equal(
    sessionService.getSession(session.id)?.lastCheckpointJson,
    JSON.stringify(checkpoint)
  );
  assert.match(
    sessionService.getSession(session.id)?.lastErrorText ?? '',
    /stale_waiting_approval_session/u
  );
  assert.deepEqual(
    sessionEventService
      .listAfterSequence(session.id, 0)
      .map((envelope) => envelope.event.type),
    ['session.recovered', 'session.updated']
  );
});
