import { Lifecycle, ToolExecutor } from '@opencode/agent';
import type { MessagePart } from '@opencode/shared';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';
import { approvalRepository } from '../repositories/approval-repository.js';
import { agentRunRepository } from '../repositories/agent-run-repository.js';
import { toolCallRepository } from '../repositories/tool-call-repository.js';
import { buildLifecycleDeps } from '../wiring/agent.js';

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

function createRunSignal() {
  return new AbortController().signal;
}

function createRun(sessionId: string) {
  return agentRunService.createRun({ sessionId });
}

function createSession() {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });

  return sessionService.createSession({
    goalText: 'Exercise lifecycle behavior',
    workspaceId: workspace.id
  });
}

function createApprovalFixture(input: {
  decision?: 'approved' | 'rejected';
  sessionId: string;
  toolName: 'bash' | 'write';
  toolInput: Record<string, unknown>;
}) {
  const now = '2026-04-27T00:00:00.000Z';
  const run = createRun(input.sessionId);
  const assistant = messageService.createMessage({
    content: [],
    role: 'assistant',
    runId: run.id,
    sessionId: input.sessionId,
    status: 'completed'
  });
  const part = partService.appendPart({
    messageId: assistant.id,
    modelToolCallId: 'model-call-test',
    order: 0,
    runId: run.id,
    sessionId: input.sessionId,
    state: {
      input: input.toolInput,
      status: 'pending'
    },
    toolCallId: 'tool-call-test',
    toolName: input.toolName,
    type: 'tool'
  });
  const toolCall = toolCallRepository.create({
    createdAt: now,
    id: 'tool-call-test',
    input: input.toolInput,
    messageId: assistant.id,
    messagePartId: part.id,
    modelToolCallId: 'model-call-test',
    requiresApproval: true,
    runId: run.id,
    sessionId: input.sessionId,
    status: 'pending_approval',
    taskId: null,
    toolName: input.toolName,
    updatedAt: now
  });
  const approval = approvalRepository.create({
    createdAt: now,
    decisionReasonText: null,
    decidedAt: null,
    decidedBy: null,
    decisionScope: 'once',
    id: 'approval-test',
    kind: input.toolName,
    payload: {},
    runId: run.id,
    sessionId: input.sessionId,
    status: input.decision ?? 'pending',
    suggestedRuleJson: null,
    taskId: null,
    toolCallId: toolCall.id
  });

  const checkpoint = buildSessionCheckpoint({
    approvalId: approval.id,
    kind: 'waiting_approval',
    messageId: assistant.id,
    modelToolCallId: 'model-call-test',
    partId: part.id,
    toolCallId: toolCall.id,
    updatedAt: now
  });

  sessionService.updateSessionRuntimeState({
    lastCheckpoint: checkpoint,
    sessionId: input.sessionId,
    status: 'waiting_approval'
  });
  agentRunService.markWaitingApproval({
    checkpoint,
    runId: run.id
  });

  return { approval, part, run, toolCall };
}

beforeEach(() => {
  resetTestDatabase();
});

afterEach(() => {
  resetTestDatabase();
});

test('Lifecycle maps loop failures to run.failed and session idle', async () => {
  const session = createSession();
  const lifecycle = new Lifecycle(
    {
      async run() {
        throw new Error('loop exploded');
      }
    },
    buildLifecycleDeps()
  );
  const run = createRun(session.id);

  const result = await lifecycle.startPromptRun({
    runId: run.id,
    signal: createRunSignal(),
    sessionId: session.id
  });

  assert.deepEqual(result, { reason: 'failed' });
  assert.equal(agentRunRepository.getById(run.id)?.status, 'failed');
  assert.equal(sessionService.getSession(session.id)?.status, 'idle');
  assert.equal(
    sessionService.getSession(session.id)?.lastErrorText,
    'loop exploded'
  );
  assert.deepEqual(
    sessionEventService
      .listAfterSequence(session.id, 0)
      .map((envelope) => envelope.event.type),
    ['run.failed', 'session.updated']
  );
});

test('Lifecycle maps completed runs to run.completed and session idle', async () => {
  const session = createSession();
  const run = createRun(session.id);
  const lifecycle = new Lifecycle(
    {
      async run() {
        return { finishReason: 'stop', kind: 'completed' };
      }
    },
    buildLifecycleDeps()
  );

  const result = await lifecycle.startPromptRun({
    runId: run.id,
    signal: createRunSignal(),
    sessionId: session.id
  });

  assert.deepEqual(result, { reason: 'completed' });
  assert.equal(agentRunRepository.getById(run.id)?.status, 'completed');
  assert.equal(sessionService.getSession(session.id)?.status, 'idle');
  assert.deepEqual(
    sessionEventService
      .listAfterSequence(session.id, 0)
      .map((envelope) => envelope.event.type),
    ['run.completed', 'session.updated']
  );
});

test('Lifecycle owns paused approval run/session state and resumable event', async () => {
  const session = createSession();
  const run = createRun(session.id);
  const assistant = messageService.createMessage({
    content: [],
    role: 'assistant',
    runId: run.id,
    sessionId: session.id,
    status: 'completed'
  });
  const createdTool = partService.createToolPartWithToolCall({
    part: {
      createdAt: '2026-04-29T14:00:00.000Z',
      id: 'part-pause-test',
      messageId: assistant.id,
      modelToolCallId: 'model-call-pause-test',
      order: 0,
      sessionId: session.id,
      state: {
        input: { command: 'pwd' },
        status: 'pending'
      },
      toolCallId: 'tool-call-pause-test',
      toolName: 'bash',
      type: 'tool',
      updatedAt: '2026-04-29T14:00:00.000Z'
    },
    toolCall: {
      createdAt: '2026-04-29T14:00:00.000Z',
      id: 'tool-call-pause-test',
      input: { command: 'pwd' },
      messageId: assistant.id,
      messagePartId: 'part-pause-test',
      modelToolCallId: 'model-call-pause-test',
      requiresApproval: true,
      runId: run.id,
      sessionId: session.id,
      status: 'pending_approval',
      taskId: null,
      toolName: 'bash',
      updatedAt: '2026-04-29T14:00:00.000Z'
    }
  });
  const approval = {
    createdAt: '2026-04-29T14:00:00.000Z',
    decisionReasonText: undefined,
    decidedAt: undefined,
    decidedBy: undefined,
    decisionScope: 'once',
    id: 'approval-pause-test',
    kind: 'bash',
    payload: { command: 'pwd' },
    runId: run.id,
    sessionId: session.id,
    status: 'pending',
    suggestedRuleJson: undefined,
    taskId: undefined,
    toolCallId: createdTool.toolCall.id
  } as const;
  const checkpoint = buildSessionCheckpoint({
    approvalId: approval.id,
    kind: 'waiting_approval',
    messageId: assistant.id,
    modelToolCallId: createdTool.toolCall.modelToolCallId,
    partId: createdTool.part.id,
    toolCallId: createdTool.toolCall.id,
    updatedAt: '2026-04-29T14:00:00.000Z'
  });
  const lifecycle = new Lifecycle(
    {
      async run() {
        return {
          approval,
          checkpoint,
          kind: 'paused_for_approval',
          toolCall: createdTool.toolCall
        };
      }
    },
    buildLifecycleDeps()
  );

  const result = await lifecycle.startPromptRun({
    runId: run.id,
    signal: createRunSignal(),
    sessionId: session.id
  });

  assert.deepEqual(result, { reason: 'paused_for_approval' });
  assert.equal(agentRunRepository.getById(run.id)?.status, 'waiting_approval');
  assert.equal(
    sessionService.getSession(session.id)?.status,
    'waiting_approval'
  );
  assert.deepEqual(
    sessionEventService
      .listAfterSequence(session.id, 0)
      .map((envelope) => envelope.event.type),
    ['tool.pending', 'approval.created', 'session.resumable', 'session.updated']
  );
});

test('Lifecycle resolves rejected approval into ToolPart error and resumes loop', async () => {
  const session = createSession();
  const { approval, toolCall, part, run } = createApprovalFixture({
    sessionId: session.id,
    toolInput: {
      content: 'export const ok = false;\n',
      filePath: 'src/index.ts'
    },
    toolName: 'write'
  });
  let runCalled = false;
  const lifecycle = new Lifecycle(
    {
      async run() {
        runCalled = true;
        return { finishReason: 'stop', kind: 'completed' };
      }
    },
    buildLifecycleDeps()
  );

  const result = await lifecycle.resumeApprovalRun({
    approval,
    decision: 'rejected',
    runId: run.id,
    signal: createRunSignal(),
    toolCall
  });

  assert.deepEqual(result, { reason: 'completed' });
  assert.equal(runCalled, true);

  const updatedPart = partService.getPart(part.id);

  assert.equal(updatedPart?.type, 'tool');
  assert.equal(
    updatedPart?.type === 'tool' ? updatedPart.state.status : undefined,
    'error'
  );
  assert.equal(
    updatedPart?.type === 'tool' && updatedPart.state.status === 'error'
      ? updatedPart.state.reason
      : undefined,
    'execution_denied'
  );
});

test('Lifecycle continues when approved tool execution writes an error result', async () => {
  const session = createSession();
  const { approval, part, run, toolCall } = createApprovalFixture({
    sessionId: session.id,
    toolInput: { command: 'definitely-missing-command-for-test' },
    toolName: 'bash'
  });
  let runCalled = false;
  const failingToolExecutor = new ToolExecutor({
    appendSessionEvent: (event) => sessionEventService.append(event),
    getMessagePart: (partId) => partService.getPart(partId),
    updateToolPartWithToolCall: (input) =>
      partService.updateToolPartWithToolCall(input)
  });
  const lifecycle = new Lifecycle(
    {
      async run() {
        runCalled = true;
        return { finishReason: 'stop', kind: 'completed' };
      }
    },
    buildLifecycleDeps({ toolExecutor: failingToolExecutor })
  );

  const result = await lifecycle.resumeApprovalRun({
    approval,
    decision: 'approved',
    runId: run.id,
    signal: createRunSignal(),
    toolCall
  });

  assert.deepEqual(result, { reason: 'completed' });
  assert.equal(runCalled, true);

  const updatedPart = partService.getPart(part.id);

  assert.equal(
    updatedPart?.type === 'tool' ? updatedPart.state.status : undefined,
    'error'
  );
  assert.equal(
    updatedPart?.type === 'tool' && updatedPart.state.status === 'error'
      ? updatedPart.state.reason
      : undefined,
    'tool_error'
  );
});

test('Lifecycle passes approval payload into approved tool execution', async () => {
  const session = createSession();
  const { approval, part, run } = createApprovalFixture({
    sessionId: session.id,
    toolInput: {
      patchText: '*** Begin Patch\n*** End Patch'
    },
    toolName: 'bash'
  });
  approval.payload = { approved: true, token: 'payload-check' };
  let receivedPayload: Record<string, unknown> | undefined;
  let runCalled = false;
  const toolPart = part as Extract<MessagePart, { type: 'tool' }>;

  const lifecycle = new Lifecycle(
    {
      async run() {
        runCalled = true;
        return { finishReason: 'stop', kind: 'completed' };
      }
    },
    buildLifecycleDeps({
      toolExecutor: {
        async executeApprovedPart(
          input: Parameters<ToolExecutor['executeApprovedPart']>[0]
        ) {
          receivedPayload = input.approvalPayload;
          return toolPart;
        }
      } as never
    })
  );

  const result = await lifecycle.resumeApprovalRun({
    approval,
    decision: 'approved',
    part: toolPart,
    runId: run.id,
    signal: createRunSignal(),
    toolCall: toolCallRepository.getById(toolPart.toolCallId)!
  });

  assert.deepEqual(result, { reason: 'completed' });
  assert.equal(runCalled, true);
  assert.deepEqual(receivedPayload, approval.payload);
});
