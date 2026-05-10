import {
  RunLoop,
  type ProcessTurnInput,
  type ProcessorResult,
  type RunLoopDeps
} from '@opencode/agent';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';
import { buildRunLoopDeps } from '../wiring/agent.js';

const { environment, messageService, sessionService, workspaceService } =
  dbTestContext;

function createSessionWithUserMessage() {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });
  const session = sessionService.createSession({
    goalText: 'Exercise run loop behavior',
    workspaceId: workspace.id
  });

  messageService.createMessage({
    content: [{ text: 'Read the file', type: 'text' }],
    role: 'user',
    sessionId: session.id
  });

  return session;
}

beforeEach(() => {
  resetTestDatabase();
});

function createDeps(overrides: Partial<RunLoopDeps> = {}): RunLoopDeps {
  return buildRunLoopDeps({
    modelFactory: () => 'openai:gpt-4.1-mini',
    ...overrides
  });
}

function createRunLoopInput(sessionId: string) {
  return {
    runId: 'run-test',
    sessionId,
    signal: new AbortController().signal,
    workspaceRoot: environment.workspaceRoot
  };
}

test('RunLoop rebuilds context and continues after auto tool execution', async () => {
  const session = createSessionWithUserMessage();
  const calls: ProcessTurnInput[] = [];
  const results: ProcessorResult[] = [
    {
      assistantMessageId: 'assistant-1',
      kind: 'tool_calls',
      toolParts: [
        {
          createdAt: '2026-04-27T00:00:00.000Z',
          id: 'part-tool-1',
          messageId: 'assistant-1',
          modelToolCallId: 'model-call-1',
          order: 0,
          sessionId: session.id,
          state: {
            input: { filePath: 'src/index.ts' },
            status: 'pending'
          },
          toolCallId: 'tool-call-1',
          toolName: 'read',
          type: 'tool',
          updatedAt: '2026-04-27T00:00:00.000Z'
        }
      ]
    },
    {
      finishReason: 'stop',
      kind: 'completed'
    }
  ];
  const processor = {
    async processTurn(input: ProcessTurnInput) {
      calls.push(input);
      const result = results.shift();

      if (!result) {
        throw new Error('Unexpected extra processor call');
      }

      return result;
    }
  };
  const toolExecutor = {
    async executePendingToolParts() {
      return { executedPartIds: ['part-tool-1'], kind: 'completed' as const };
    }
  };
  const loop = new RunLoop(processor, toolExecutor, createDeps());
  const result = await loop.run(createRunLoopInput(session.id));

  assert.deepEqual(result, { finishReason: 'stop', kind: 'completed' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.request.messages[0]?.role, 'user');
});

test('RunLoop does not call model when session is waiting approval', async () => {
  const session = createSessionWithUserMessage();
  let called = false;

  sessionService.updateSessionRuntimeState({
    sessionId: session.id,
    status: 'waiting_approval'
  });

  const loop = new RunLoop(
    {
      async processTurn() {
        called = true;
        return { finishReason: 'stop', kind: 'completed' };
      }
    },
    {
      async executePendingToolParts() {
        return { executedPartIds: [], kind: 'completed' as const };
      }
    },
    createDeps()
  );
  const result = await loop.run(createRunLoopInput(session.id));

  assert.deepEqual(result, { kind: 'paused_for_approval' });
  assert.equal(called, false);
});
