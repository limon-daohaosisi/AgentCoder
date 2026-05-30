import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';
import { SessionRunner } from '../services/agent/runner.js';
import { SubagentService } from '../services/agent/subagent-service.js';

const { agentRunService, messageService, sessionService, workspaceService } =
  dbTestContext;

beforeEach(() => {
  resetTestDatabase();
});

test('SubagentService creates a child explore session and returns final summary text', async () => {
  const workspace = workspaceService.createWorkspace({
    rootPath: dbTestContext.environment.workspaceRoot
  });
  const parent = sessionService.createSession({
    goalText: 'Parent task',
    workspaceId: workspace.id
  });
  const runner = new SessionRunner();
  const service = new SubagentService(runner, {
    async startPromptRun(input: {
      runId: string;
      sessionId: string;
      signal: AbortSignal;
    }) {
      messageService.createMessage({
        content: [
          {
            text: 'Key finding: apps/web/src/router.tsx is the main router entry.',
            type: 'text'
          }
        ],
        role: 'assistant',
        runId: input.runId,
        sessionId: input.sessionId,
        status: 'completed'
      });
      agentRunService.finalizeRunState({
        reason: 'completed',
        runId: input.runId,
        sessionId: input.sessionId,
        sessionStatus: 'idle'
      });

      return { reason: 'completed' };
    }
  } as never);

  const result = await service.runSubagent({
    description: 'Inspect router entrypoints',
    parentSignal: undefined,
    parentSessionId: parent.id,
    parentToolCallId: 'tool-call-agent-1',
    prompt: 'Find the main router files.',
    subagentType: 'explore',
    workspaceRoot: dbTestContext.environment.workspaceRoot
  });

  assert.equal(result.status, 'completed');
  assert.match(result.summaryText, /main router entry/);

  const child = sessionService.getSession(result.sessionId);

  assert.equal(child?.kind, 'subagent');
  assert.equal(child?.parentSessionId, parent.id);
  assert.equal(child?.parentToolCallId, 'tool-call-agent-1');
  assert.equal(child?.subagentType, 'explore');
});

test('SubagentService throws when the child run does not complete successfully', async () => {
  const workspace = workspaceService.createWorkspace({
    rootPath: dbTestContext.environment.workspaceRoot
  });
  const parent = sessionService.createSession({
    goalText: 'Parent task',
    workspaceId: workspace.id
  });
  const runner = new SessionRunner();
  const service = new SubagentService(runner, {
    async startPromptRun(input: {
      runId: string;
      sessionId: string;
      signal: AbortSignal;
    }) {
      agentRunService.finalizeRunState({
        errorText: 'Subagent failed',
        reason: 'failed',
        runId: input.runId,
        sessionId: input.sessionId,
        sessionStatus: 'blocked'
      });

      return { reason: 'failed' };
    }
  } as never);

  await assert.rejects(
    () =>
      service.runSubagent({
        description: 'Inspect router entrypoints',
        parentSignal: undefined,
        parentSessionId: parent.id,
        parentToolCallId: 'tool-call-agent-1',
        prompt: 'Find the main router files.',
        subagentType: 'explore',
        workspaceRoot: dbTestContext.environment.workspaceRoot
      }),
    /Subagent run ended with status: failed/
  );
});

test('SubagentService cancels the child run when the parent signal aborts', async () => {
  const workspace = workspaceService.createWorkspace({
    rootPath: dbTestContext.environment.workspaceRoot
  });
  const parent = sessionService.createSession({
    goalText: 'Parent task',
    workspaceId: workspace.id
  });
  const runner = new SessionRunner();
  const controller = new AbortController();
  const service = new SubagentService(runner, {
    async startPromptRun(input: {
      runId: string;
      sessionId: string;
      signal: AbortSignal;
    }) {
      const finalizeCancelled = () => {
        agentRunService.finalizeRunState({
          errorText: 'Run cancelled by user',
          reason: 'cancelled',
          runId: input.runId,
          sessionId: input.sessionId,
          sessionStatus: 'idle'
        });
      };

      if (input.signal.aborted) {
        finalizeCancelled();
        return { reason: 'cancelled' };
      }

      await new Promise<void>((resolve) => {
        input.signal.addEventListener(
          'abort',
          () => {
            finalizeCancelled();
            resolve();
          },
          { once: true }
        );
      });

      return { reason: 'cancelled' };
    }
  } as never);

  const running = service.runSubagent({
    description: 'Inspect router entrypoints',
    parentSignal: controller.signal,
    parentSessionId: parent.id,
    parentToolCallId: 'tool-call-agent-1',
    prompt: 'Find the main router files.',
    subagentType: 'explore',
    workspaceRoot: dbTestContext.environment.workspaceRoot
  });

  controller.abort(new Error('Run cancelled by user'));

  await assert.rejects(running, /Subagent run ended with status: cancelled/);
});
