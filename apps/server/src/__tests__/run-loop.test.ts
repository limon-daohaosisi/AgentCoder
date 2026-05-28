import {
  dumpSentModelRequest,
  RunLoop,
  type ProcessTurnInput,
  type ProcessorResult,
  type RunLoopDeps,
  type SessionCompactionDeps,
  type StreamModelResponse
} from '@opencode/agent';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';
import { buildRunLoopDeps } from '../wiring/agent.js';

const { environment, messageService, sessionService, workspaceService } =
  dbTestContext;
const debugRequestRoot = path.join(tmpdir(), 'mycoding', 'model-requests');

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
  rmSync(debugRequestRoot, { force: true, recursive: true });
  delete process.env.OPENCODE_DEBUG_MODEL_REQUESTS;
});

function createDeps(overrides: Partial<RunLoopDeps> = {}): RunLoopDeps {
  return buildRunLoopDeps({
    modelFactory: () => 'openai:gpt-4.1-mini',
    ...overrides
  });
}

function createCompactionDeps(
  overrides: Partial<SessionCompactionDeps> = {}
): SessionCompactionDeps {
  const base: SessionCompactionDeps = {
    appendSessionEvent: (event) =>
      dbTestContext.sessionEventService.append(event),
    createMessage: (input) => messageService.createMessage(input),
    getSession: (sessionId) => sessionService.getSession(sessionId),
    listMessages: (sessionId) => messageService.listMessages(sessionId),
    listRecentFileSnapshots: () => [],
    markMessagesCompacted: () => undefined,
    modelFactory: () => 'openai:gpt-4.1-mini' as never,
    persist: (callback) => callback(),
    repairDanglingToolPart: (input) => input.part,
    streamModelResponse: (() => {
      throw new Error(
        'streamModelResponse must be overridden for compaction tests'
      );
    }) as SessionCompactionDeps['streamModelResponse'],
    updateMessagePart: (part) => dbTestContext.partService.updatePart(part),
    updateMessageRuntime: () => null,
    updateToolPartWithToolCall: (input) =>
      dbTestContext.partService.updateToolPartWithToolCall(input)
  };

  const streamModelResponse = overrides.streamModelResponse
    ? (
        request: Parameters<StreamModelResponse>[0],
        options?: Parameters<StreamModelResponse>[1]
      ) => {
        dumpSentModelRequest(request);
        return overrides.streamModelResponse!(request, options);
      }
    : base.streamModelResponse;

  return {
    ...base,
    ...overrides,
    streamModelResponse
  };
}

function createRunLoopInput(sessionId: string) {
  return {
    runId: 'run-test',
    sessionId,
    signal: new AbortController().signal,
    workspaceRoot: environment.workspaceRoot
  };
}

function createPersistedRun(sessionId: string) {
  return dbTestContext.agentRunService.createRun({ sessionId });
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

test('RunLoop auto compacts and continues when context needs full compaction', async () => {
  const session = createSessionWithUserMessage();
  const run = createPersistedRun(session.id);
  writeFileSync(
    path.join(environment.workspaceRoot, 'AGENTS.md'),
    '# Workspace Memory\nKeep project constraints visible.\n'
  );
  messageService.createMessage({
    content: [{ text: 'Prior assistant output', type: 'text' }],
    role: 'assistant',
    sessionId: session.id
  });
  const compactSystems: string[] = [];
  let modelCalls = 0;

  const processor = {
    async processTurn(input: ProcessTurnInput) {
      modelCalls += 1;

      assert.ok(
        input.request.system.includes('<project-memory source="AGENTS.md"')
      );
      assert.ok(
        input.request.system.includes('Keep project constraints visible.')
      );
      assert.equal(input.request.system.includes('Do not call tools.'), false);
      assert.ok(
        input.request.messages.some(
          (message) =>
            message.role === 'assistant' &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) =>
                'text' in part &&
                typeof part.text === 'string' &&
                part.text.includes('Current Objective')
            )
        )
      );

      return {
        finishReason: 'stop' as const,
        kind: 'completed' as const
      };
    }
  };
  const loop = new RunLoop(
    processor,
    {
      async executePendingToolParts() {
        return { executedPartIds: [], kind: 'completed' as const };
      }
    },
    createDeps(),
    createCompactionDeps({
      streamModelResponse: ((request: Parameters<StreamModelResponse>[0]) => {
        compactSystems.push(request.system);

        return {
          fullStream: {
            async *[Symbol.asyncIterator]() {
              yield {
                id: 'compact-summary-1',
                text: '<analysis>draft</analysis><summary>Current Objective\n- Continue the task</summary>',
                type: 'text-delta'
              };
              yield {
                response: { id: 'compact-response-1' },
                type: 'finish-step',
                usage: {
                  inputTokenDetails: {},
                  inputTokens: 1,
                  outputTokenDetails: {},
                  outputTokens: 1,
                  totalTokens: 2
                }
              };
              yield {
                totalUsage: {
                  inputTokenDetails: {},
                  inputTokens: 1,
                  outputTokenDetails: {},
                  outputTokens: 1,
                  totalTokens: 2
                },
                type: 'finish'
              };
            }
          }
        };
      }) as unknown as StreamModelResponse
    }),
    2
  );

  const originalAnalyze = loop['sizeGuard'].analyze.bind(loop['sizeGuard']);
  let analyzeCalls = 0;
  loop['sizeGuard'].analyze = ((input) => {
    analyzeCalls += 1;

    if (analyzeCalls === 1) {
      return {
        estimatedRequestTokens: 80_000,
        fits: false,
        hardFailTokens: 96_000,
        recommendation: 'needs_full_compaction',
        softBudgetTokens: 56_000
      };
    }

    return originalAnalyze(input);
  }) as (typeof loop)['sizeGuard']['analyze'];

  const result = await loop.run({
    ...createRunLoopInput(session.id),
    runId: run.id
  });

  assert.deepEqual(result, { finishReason: 'stop', kind: 'completed' });
  assert.equal(modelCalls, 1);
  assert.equal(compactSystems.length, 1);
  assert.match(compactSystems[0] ?? '', /<project-memory source="AGENTS.md"/);
  assert.match(compactSystems[0] ?? '', /Do not call tools\./);
  assert.ok(
    messageService
      .listMessages(session.id)
      .some(
        (message) =>
          message.summary === true &&
          message.content.some((part) => part.type === 'summary')
      )
  );
  assert.ok(
    dbTestContext.sessionEventService
      .listAfterSequence(session.id, 0)
      .some(
        (envelope) =>
          envelope.event.type === 'message.part.created' &&
          envelope.event.part.type === 'summary'
      )
  );
  assert.ok(
    dbTestContext.sessionEventService
      .listAfterSequence(session.id, 0)
      .some(
        (envelope) =>
          envelope.event.type === 'message.part.updated' &&
          envelope.event.part.type === 'summary'
      )
  );
});

test('RunLoop dumps only dispatched model requests when request debug is enabled', async () => {
  process.env.OPENCODE_DEBUG_MODEL_REQUESTS = '1';

  const session = createSessionWithUserMessage();
  const run = createPersistedRun(session.id);
  const compactSystems: string[] = [];
  let modelCalls = 0;

  const processor = {
    async processTurn(input: ProcessTurnInput) {
      dumpSentModelRequest(input.request);
      modelCalls += 1;
      return {
        finishReason: 'stop' as const,
        kind: 'completed' as const
      };
    }
  };

  const loop = new RunLoop(
    processor,
    {
      async executePendingToolParts() {
        return { executedPartIds: [], kind: 'completed' as const };
      }
    },
    createDeps(),
    createCompactionDeps({
      streamModelResponse: ((request: Parameters<StreamModelResponse>[0]) => {
        compactSystems.push(request.system);
        return {
          fullStream: {
            async *[Symbol.asyncIterator]() {
              yield {
                id: 'compact-summary-debug',
                text: '<summary>Current Objective\n- Continue safely</summary>',
                type: 'text-delta'
              };
              yield {
                response: { id: 'compact-response-debug' },
                type: 'finish-step',
                usage: {
                  inputTokenDetails: {},
                  inputTokens: 1,
                  outputTokenDetails: {},
                  outputTokens: 1,
                  totalTokens: 2
                }
              };
              yield {
                totalUsage: {
                  inputTokenDetails: {},
                  inputTokens: 1,
                  outputTokenDetails: {},
                  outputTokens: 1,
                  totalTokens: 2
                },
                type: 'finish'
              };
            }
          }
        };
      }) as unknown as StreamModelResponse
    }),
    2
  );

  const originalAnalyze = loop['sizeGuard'].analyze.bind(loop['sizeGuard']);
  let analyzeCalls = 0;
  loop['sizeGuard'].analyze = ((input) => {
    analyzeCalls += 1;

    if (analyzeCalls === 1) {
      return {
        estimatedRequestTokens: 80_000,
        fits: false,
        hardFailTokens: 96_000,
        recommendation: 'needs_full_compaction',
        softBudgetTokens: 56_000
      };
    }

    return originalAnalyze(input);
  }) as (typeof loop)['sizeGuard']['analyze'];

  const result = await loop.run({
    ...createRunLoopInput(session.id),
    runId: run.id
  });

  assert.deepEqual(result, { finishReason: 'stop', kind: 'completed' });
  assert.equal(modelCalls, 1);
  assert.equal(compactSystems.length, 1);

  const files = readdirSync(debugRequestRoot).sort();

  assert.equal(files.length, 2);
  assert.match(files[0] ?? '', /^compaction__/u);
  assert.match(files[1] ?? '', /^run_loop__/u);

  const compactionPayload = JSON.parse(
    readFileSync(path.join(debugRequestRoot, files[0]!), 'utf8')
  ) as Record<string, unknown>;
  const runLoopPayload = JSON.parse(
    readFileSync(path.join(debugRequestRoot, files[1]!), 'utf8')
  ) as Record<string, unknown>;

  assert.equal(
    typeof (
      compactionPayload.providerOptions as {
        openai?: { instructions?: unknown };
      }
    )?.openai?.instructions,
    'string'
  );
  assert.equal('system' in compactionPayload, false);
  assert.equal(Array.isArray(compactionPayload.messages), true);
  assert.equal('toolPolicies' in compactionPayload, false);
  assert.equal(Array.isArray(runLoopPayload.messages), true);
  assert.equal(typeof runLoopPayload.providerId, 'string');
  assert.equal('cacheDebug' in runLoopPayload, false);
});

test('RunLoop blocks when compact summary attempts to call a tool', async () => {
  const session = createSessionWithUserMessage();
  const run = createPersistedRun(session.id);
  const loop = new RunLoop(
    {
      async processTurn() {
        throw new Error('main processor should not run after compact failure');
      }
    },
    {
      async executePendingToolParts() {
        return { executedPartIds: [], kind: 'completed' as const };
      }
    },
    createDeps(),
    createCompactionDeps({
      streamModelResponse: (() => ({
        fullStream: {
          async *[Symbol.asyncIterator]() {
            yield {
              input: { command: 'pwd' },
              toolCallId: 'compact-tool-call',
              toolName: 'bash',
              type: 'tool-call'
            };
            yield {
              finishReason: 'tool-calls',
              response: { id: 'compact-response-2' },
              type: 'finish-step',
              usage: {
                inputTokenDetails: {},
                inputTokens: 1,
                outputTokenDetails: {},
                outputTokens: 1,
                totalTokens: 2
              }
            };
          }
        }
      })) as unknown as StreamModelResponse
    }),
    2
  );
  loop['sizeGuard'].analyze = (() => ({
    estimatedRequestTokens: 80_000,
    fits: false,
    hardFailTokens: 96_000,
    recommendation: 'needs_full_compaction',
    softBudgetTokens: 56_000
  })) as (typeof loop)['sizeGuard']['analyze'];

  const result = await loop.run({
    ...createRunLoopInput(session.id),
    runId: run.id
  });

  assert.deepEqual(result, {
    error: 'Compact summary attempted to call a tool.',
    kind: 'context_too_large'
  });
});

test('RunLoop escalates to full compaction when tool-result compaction is insufficient', async () => {
  const session = createSessionWithUserMessage();
  const run = createPersistedRun(session.id);
  let modelCalls = 0;
  let oldToolCompactions = 0;
  let fullCompactions = 0;

  const loop = new RunLoop(
    {
      async processTurn() {
        modelCalls += 1;
        return {
          finishReason: 'stop' as const,
          kind: 'completed' as const
        };
      }
    },
    {
      async executePendingToolParts() {
        return { executedPartIds: [], kind: 'completed' as const };
      }
    },
    createDeps(),
    createCompactionDeps({
      streamModelResponse: (() => ({
        fullStream: {
          async *[Symbol.asyncIterator]() {
            yield {
              id: 'compact-summary-3',
              text: '<summary>Current Objective\n- Continue safely</summary>',
              type: 'text-delta'
            };
            yield {
              response: { id: 'compact-response-3' },
              type: 'finish-step',
              usage: {
                inputTokenDetails: {},
                inputTokens: 1,
                outputTokenDetails: {},
                outputTokens: 1,
                totalTokens: 2
              }
            };
            yield {
              totalUsage: {
                inputTokenDetails: {},
                inputTokens: 1,
                outputTokenDetails: {},
                outputTokens: 1,
                totalTokens: 2
              },
              type: 'finish'
            };
          }
        }
      })) as unknown as StreamModelResponse
    }),
    2
  );
  const compaction = loop['compaction'];

  assert.ok(compaction);

  const originalCompactOldToolOutputs =
    compaction.compactOldToolOutputs.bind(compaction);
  compaction.compactOldToolOutputs = ((
    input: Parameters<typeof originalCompactOldToolOutputs>[0]
  ) => {
    oldToolCompactions += 1;
    return originalCompactOldToolOutputs(input);
  }) as typeof compaction.compactOldToolOutputs;

  const originalRunAutoCompaction =
    compaction.runAutoCompaction.bind(compaction);
  compaction.runAutoCompaction = (async (
    input: Parameters<typeof originalRunAutoCompaction>[0]
  ) => {
    fullCompactions += 1;
    return originalRunAutoCompaction(input);
  }) as typeof compaction.runAutoCompaction;

  let analyzeCalls = 0;
  loop['sizeGuard'].analyze = (() => {
    analyzeCalls += 1;

    if (analyzeCalls <= 2) {
      return {
        estimatedRequestTokens: 70_000,
        fits: false,
        hardFailTokens: 96_000,
        recommendation: 'needs_tool_result_compaction' as const,
        softBudgetTokens: 56_000
      };
    }

    return {
      estimatedRequestTokens: 50_000,
      fits: true,
      hardFailTokens: 96_000,
      recommendation: 'fits' as const,
      softBudgetTokens: 56_000
    };
  }) as (typeof loop)['sizeGuard']['analyze'];

  const result = await loop.run({
    ...createRunLoopInput(session.id),
    runId: run.id
  });

  assert.deepEqual(result, { finishReason: 'stop', kind: 'completed' });
  assert.equal(oldToolCompactions, 1);
  assert.equal(fullCompactions, 1);
  assert.equal(modelCalls, 1);
});
