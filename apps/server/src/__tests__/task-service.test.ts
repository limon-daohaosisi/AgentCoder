import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';
import { planService } from '../services/session/plan-service.js';
import { taskService } from '../services/session/task-service.js';

const { environment, messageService, sessionService, workspaceService } =
  dbTestContext;

beforeEach(() => {
  resetTestDatabase();
});

function createSession(variant: 'build' | 'plan' = 'plan') {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });
  const session = sessionService.createSession({
    defaultVariant: variant,
    goalText: 'Exercise task service behavior',
    workspaceId: workspace.id
  });

  messageService.createMessage({
    content: [{ text: 'Start working', type: 'text' }],
    role: 'user',
    runtime: { format: { type: 'text' }, variant },
    sessionId: session.id
  });

  return session;
}

function switchToBuildMode(sessionId: string) {
  messageService.createMessage({
    content: [{ text: 'Continue in build mode', type: 'text' }],
    role: 'user',
    runtime: { format: { type: 'text' }, variant: 'build' },
    sessionId
  });
}

test('taskService.createTask only allows creation in plan mode', () => {
  const session = createSession('plan');
  const task = taskService.createTask({
    acceptanceCriteria: ['Task exists on the board'],
    sessionId: session.id,
    title: 'Create first task'
  });

  assert.equal(task.status, 'todo');
  assert.equal(task.title, 'Create first task');
  assert.equal(sessionService.getSession(session.id)?.currentTaskId, task.id);

  const buildSession = createSession('build');

  assert.throws(
    () =>
      taskService.createTask({
        sessionId: buildSession.id,
        title: 'Should fail in build mode'
      }),
    /only allowed in plan mode/u
  );
});

test('taskService.updateTask enforces plan/build field restrictions and currentTaskId linkage', () => {
  const planSession = createSession('plan');
  const planTask = taskService.createTask({
    sessionId: planSession.id,
    title: 'Draft task'
  });

  const updatedPlanTask = taskService.updateTask({
    acceptanceCriteria: ['Updated in plan mode'],
    completedAt: null,
    lastErrorText: null,
    position: 3,
    sessionId: planSession.id,
    startedAt: '2026-05-13T11:55:00.000Z',
    status: 'running',
    summaryText: 'Planning in progress',
    taskId: planTask.id,
    title: 'Refined task'
  });

  assert.equal(updatedPlanTask.status, 'running');
  assert.equal(updatedPlanTask.title, 'Refined task');
  assert.deepEqual(updatedPlanTask.acceptanceCriteria, ['Updated in plan mode']);
  assert.equal(updatedPlanTask.summaryText, 'Planning in progress');
  assert.equal(
    sessionService.getSession(planSession.id)?.currentTaskId,
    updatedPlanTask.id
  );

  const buildSession = createSession('plan');
  const board = planService.getSessionPlanBoard(buildSession.id);
  const buildTask = taskService.createTask({
    sessionId: buildSession.id,
    title: 'Seed task for build'
  });

  void board;

  switchToBuildMode(buildSession.id);

  assert.throws(
    () =>
      taskService.updateTask({
        sessionId: buildSession.id,
        taskId: buildTask.id,
        title: 'Should not rename in build'
      }),
    /Build mode only allows execution-field/u
  );

  const runningTask = taskService.updateTask({
    sessionId: buildSession.id,
    startedAt: '2026-05-13T12:00:00.000Z',
    status: 'running',
    taskId: buildTask.id
  });

  assert.equal(runningTask.status, 'running');
  assert.equal(sessionService.getSession(buildSession.id)?.currentTaskId, buildTask.id);

  const doneTask = taskService.updateTask({
    completedAt: '2026-05-13T12:10:00.000Z',
    sessionId: buildSession.id,
    status: 'done',
    summaryText: 'Finished execution',
    taskId: buildTask.id
  });

  assert.equal(doneTask.status, 'done');
  assert.equal(sessionService.getSession(buildSession.id)?.currentTaskId, undefined);
});

test('taskService.stopTask blocks the task and clears currentTaskId', () => {
  const session = createSession('plan');
  const board = planService.getSessionPlanBoard(session.id);

  void board;

  const task = taskService.createTask({
    sessionId: session.id,
    title: 'Seed task'
  });

  switchToBuildMode(session.id);

  taskService.updateTask({
    sessionId: session.id,
    startedAt: '2026-05-13T12:00:00.000Z',
    status: 'running',
    taskId: task.id
  });

  const stopped = taskService.stopTask({
    reason: 'Waiting for external dependency',
    sessionId: session.id,
    summaryText: 'Paused for later recovery',
    taskId: task.id
  });

  assert.equal(stopped.status, 'blocked');
  assert.equal(stopped.lastErrorText, 'Waiting for external dependency');
  assert.equal(sessionService.getSession(session.id)?.currentTaskId, undefined);
});
