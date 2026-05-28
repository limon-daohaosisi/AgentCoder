import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';
import { parseJson } from './server-test-helpers.js';
import { approvalRepository } from '../repositories/approval-repository.js';
import { taskRepository } from '../repositories/task-repository.js';
import { toolCallRepository } from '../repositories/tool-call-repository.js';
import { planService } from '../services/session/plan-service.js';

const { app, environment, sessionService, workspaceService } = dbTestContext;

beforeEach(() => {
  resetTestDatabase();
});

test('planService.getSessionPlanBoard creates and persists the current plan', () => {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });
  const session = sessionService.createSession({
    goalText: 'Create a real plan board for this session',
    workspaceId: workspace.id
  });

  assert.equal(session.currentPlanId, undefined);

  const firstBoard = planService.getSessionPlanBoard(session.id);
  const secondBoard = planService.getSessionPlanBoard(session.id);
  const updatedSession = sessionService.getSession(session.id);

  assert.ok(firstBoard.currentPlan);
  assert.equal(firstBoard.currentPlan?.sessionId, session.id);
  assert.equal(
    firstBoard.currentPlan?.filePath,
    `.mycoding/plans/${firstBoard.currentPlan?.id}.md`
  );
  assert.equal(firstBoard.tasks.length, 0);
  assert.deepEqual(firstBoard.waitingApprovalTaskIds, []);
  assert.equal(secondBoard.currentPlan?.id, firstBoard.currentPlan?.id);
  assert.equal(updatedSession?.currentPlanId, firstBoard.currentPlan?.id);
});

test('GET /api/sessions/:sessionId/plan-file returns current plan file content', async () => {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });
  const session = sessionService.createSession({
    goalText: 'Inspect the current plan file payload',
    workspaceId: workspace.id
  });

  const response = await app.request(`/api/sessions/${session.id}/plan-file`);

  assert.equal(response.status, 200);

  const payload = await parseJson<{
    content: string;
    exists: boolean;
    filePath: string;
    plan: { filePath?: string; id: string; sessionId: string };
  }>(response);

  assert.equal(payload.data?.plan.sessionId, session.id);
  assert.equal(payload.data?.filePath, payload.data?.plan.filePath);
  assert.equal(payload.data?.exists, false);
  assert.equal(payload.data?.content, '');
});

test('planService.buildPlanExitApprovalPayload returns full plan file data', async () => {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });
  const session = sessionService.createSession({
    goalText: 'Prepare a plan_exit approval payload',
    workspaceId: workspace.id
  });

  await assert.rejects(
    () =>
      planService.buildPlanExitApprovalPayload({
        sessionId: session.id,
        summary: 'Ready to implement'
      }),
    /Current plan file does not exist yet|Plan file/i
  );
});

test('GET /api/sessions/:sessionId/plan-board returns ordered tasks and approval aggregation', async () => {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });
  const session = sessionService.createSession({
    goalText: 'Inspect the plan board payload',
    workspaceId: workspace.id
  });
  const board = planService.getSessionPlanBoard(session.id);
  const now = '2026-05-13T12:00:00.000Z';

  const readyTask = taskRepository.create({
    acceptanceCriteria: ['List the current tasks in order'],
    completedAt: null,
    description: 'Summarize the current board',
    id: 'task-plan-board-ready',
    lastErrorText: null,
    planId: board.currentPlan!.id,
    position: 2,
    sessionId: session.id,
    startedAt: null,
    status: 'ready',
    summaryText: 'Board summary pending',
    title: 'List tasks',
    updatedAt: now
  });
  const waitingTask = taskRepository.create({
    acceptanceCriteria: ['Wait for approval before continuing'],
    completedAt: null,
    description: 'Apply the approved change',
    id: 'task-plan-board-waiting',
    lastErrorText: null,
    planId: board.currentPlan!.id,
    position: 1,
    sessionId: session.id,
    startedAt: now,
    status: 'waiting_approval',
    summaryText: 'Blocked on approval',
    title: 'Apply patch',
    updatedAt: now
  });

  sessionService.updateSessionRuntimeState({
    currentTaskId: waitingTask.id,
    sessionId: session.id
  });

  const toolCall = toolCallRepository.create({
    createdAt: now,
    id: 'tool-call-plan-board',
    input: {
      patch: '*** Begin Patch\n*** End Patch'
    },
    messageId: null,
    messagePartId: null,
    modelToolCallId: 'model-tool-call-plan-board',
    requiresApproval: true,
    runId: null,
    sessionId: session.id,
    status: 'pending_approval',
    taskId: waitingTask.id,
    toolName: 'apply_patch',
    updatedAt: now
  });

  approvalRepository.create({
    createdAt: now,
    decisionReasonText: null,
    decidedAt: null,
    decidedBy: null,
    decisionScope: 'once',
    id: 'approval-plan-board',
    kind: 'apply_patch',
    payload: {
      changes: ['apps/web/src/features/tasks/task-board.tsx']
    },
    runId: null,
    sessionId: session.id,
    status: 'pending',
    suggestedRuleJson: null,
    taskId: waitingTask.id,
    toolCallId: toolCall.id
  });

  const response = await app.request(`/api/sessions/${session.id}/plan-board`);

  assert.equal(response.status, 200);

  const payload = await parseJson<{
    currentPlan?: { id: string; sessionId: string };
    currentTask?: { id: string; status: string };
    session: { currentPlanId?: string; currentTaskId?: string; id: string };
    tasks: Array<{
      id: string;
      position: number;
      status: string;
      title: string;
    }>;
    waitingApprovalTaskIds: string[];
  }>(response);

  assert.equal(payload.data?.session.id, session.id);
  assert.equal(payload.data?.currentPlan?.id, board.currentPlan?.id);
  assert.equal(payload.data?.session.currentPlanId, board.currentPlan?.id);
  assert.equal(payload.data?.session.currentTaskId, waitingTask.id);
  assert.equal(payload.data?.currentTask?.id, waitingTask.id);
  assert.deepEqual(
    payload.data?.tasks.map((task) => task.id),
    [waitingTask.id, readyTask.id]
  );
  assert.deepEqual(payload.data?.waitingApprovalTaskIds, [waitingTask.id]);
});

test('GET /api/sessions/:sessionId/plan-board returns 404 for missing sessions', async () => {
  const response = await app.request(
    '/api/sessions/missing-session/plan-board'
  );

  assert.equal(response.status, 404);
  assert.equal(
    (await parseJson(response)).error,
    'Session not found: missing-session'
  );
});
