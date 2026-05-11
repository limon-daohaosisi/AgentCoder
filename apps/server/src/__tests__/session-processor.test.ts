import {
  SessionProcessor,
  type AiSdkTurnRequest,
  type ModelResponseStream,
  type StreamModelResponse
} from '@opencode/agent';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';
import { toolCallRepository } from '../repositories/tool-call-repository.js';
import { buildSessionProcessorDeps } from '../wiring/agent.js';

const {
  agentRunService,
  environment,
  fileSnapshotService,
  messageService,
  sessionEventService,
  sessionService,
  workspaceService
} = dbTestContext;

function createFakeStream(input: {
  events: Array<Record<string, unknown>>;
}): ModelResponseStream {
  return {
    fullStream: {
      async *[Symbol.asyncIterator]() {
        for (const event of input.events) {
          yield event;
        }
      }
    }
  } as unknown as ModelResponseStream;
}

function createRequest(
  overrides: Partial<AiSdkTurnRequest> = {}
): AiSdkTurnRequest {
  return {
    messages: [],
    model: 'openai:gpt-4.1-mini',
    modelId: 'gpt-4.1-mini',
    providerId: 'openai',
    system: 'system',
    toolExecutionMode: 'manual',
    toolPolicies: {},
    tools: {},
    ...overrides
  };
}

function createSession() {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });

  return sessionService.createSession({
    goalText: 'Exercise session processor behavior',
    workspaceId: workspace.id
  });
}

function createProcessTurnInput(input: {
  request: AiSdkTurnRequest;
  runId: string;
  sessionId: string;
}) {
  return {
    request: input.request,
    runId: input.runId,
    sessionId: input.sessionId,
    signal: new AbortController().signal,
    workspaceRoot: environment.workspaceRoot
  };
}

beforeEach(() => {
  resetTestDatabase();
});

afterEach(() => {
  resetTestDatabase();
});

test('SessionProcessor persists streamed assistant text and completes the turn', async () => {
  const session = createSession();
  const run = agentRunService.createRun({ sessionId: session.id });
  const processor = new SessionProcessor(
    buildSessionProcessorDeps({
      streamModelResponse: (() =>
        createFakeStream({
          events: [
            { id: 'text-1', text: 'Hello', type: 'text-delta' },
            { id: 'text-1', text: ' world', type: 'text-delta' },
            {
              finishReason: 'stop',
              providerMetadata: { provider: 'test' },
              response: {
                id: 'resp-text',
                modelId: 'gpt-test',
                timestamp: new Date('2026-04-27T00:00:00.000Z')
              },
              type: 'finish-step',
              usage: {
                inputTokenDetails: {},
                inputTokens: 1,
                outputTokenDetails: {},
                outputTokens: 2,
                totalTokens: 3
              }
            },
            {
              finishReason: 'stop',
              totalUsage: {
                inputTokenDetails: {},
                inputTokens: 1,
                outputTokenDetails: {},
                outputTokens: 2,
                totalTokens: 3
              },
              type: 'finish'
            }
          ]
        })) as StreamModelResponse
    })
  );
  const result = await processor.processTurn(
    createProcessTurnInput({
      request: createRequest(),
      runId: run.id,
      sessionId: session.id
    })
  );

  assert.deepEqual(result, {
    finishReason: 'stop',
    kind: 'completed'
  });

  const messages = messageService.listMessages(session.id);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, 'assistant');
  assert.equal(messages[0]?.status, 'completed');
  assert.equal(messages[0]?.modelResponseId, 'resp-text');
  assert.deepEqual(
    messages[0]?.content.map((part) => ({
      text: part.type === 'text' ? part.text : undefined,
      type: part.type
    })),
    [{ text: 'Hello world', type: 'text' }]
  );
  assert.deepEqual(
    sessionEventService
      .listAfterSequence(session.id, 0)
      .map((envelope) => envelope.event.type),
    [
      'message.created',
      'message.part.created',
      'message.part.delta',
      'message.completed'
    ]
  );
});

test('SessionProcessor emits reasoning part events for reasoning deltas', async () => {
  const session = createSession();
  const run = agentRunService.createRun({ sessionId: session.id });
  const processor = new SessionProcessor(
    buildSessionProcessorDeps({
      streamModelResponse: (() =>
        createFakeStream({
          events: [
            { id: 'reasoning-1', text: 'Think', type: 'reasoning-delta' },
            { id: 'reasoning-1', text: ' harder', type: 'reasoning-delta' },
            {
              finishReason: 'stop',
              response: {
                id: 'resp-reasoning',
                modelId: 'gpt-test',
                timestamp: new Date('2026-04-27T00:00:00.000Z')
              },
              type: 'finish-step',
              usage: {
                inputTokenDetails: {},
                inputTokens: 1,
                outputTokenDetails: {},
                outputTokens: 2,
                totalTokens: 3
              }
            }
          ]
        })) as StreamModelResponse
    })
  );

  const result = await processor.processTurn(
    createProcessTurnInput({
      request: createRequest(),
      runId: run.id,
      sessionId: session.id
    })
  );

  assert.deepEqual(result, {
    finishReason: 'stop',
    kind: 'completed'
  });

  const [message] = messageService.listMessages(session.id);

  assert.equal(message?.content[0]?.type, 'reasoning');
  assert.equal(
    message?.content[0]?.type === 'reasoning'
      ? message.content[0].text
      : undefined,
    'Think harder'
  );
  assert.deepEqual(
    sessionEventService
      .listAfterSequence(session.id, 0)
      .map((envelope) => envelope.event.type),
    [
      'message.created',
      'message.part.created',
      'message.part.delta',
      'message.completed'
    ]
  );
});

test('SessionProcessor persists compaction summaries as summary messages during streaming', async () => {
  const session = createSession();
  const run = agentRunService.createRun({ sessionId: session.id });
  const processor = new SessionProcessor(
    buildSessionProcessorDeps({
      streamModelResponse: (() =>
        createFakeStream({
          events: [
            {
              id: 'summary-1',
              text: '<analysis>draft</analysis><summary>Current Objective\n- Continue</summary>',
              type: 'text-delta'
            },
            {
              finishReason: 'stop',
              response: {
                id: 'resp-summary',
                modelId: 'gpt-test',
                timestamp: new Date('2026-05-11T00:00:00.000Z')
              },
              type: 'finish-step',
              usage: {
                inputTokenDetails: {},
                inputTokens: 1,
                outputTokenDetails: {},
                outputTokens: 2,
                totalTokens: 3
              }
            },
            {
              finishReason: 'stop',
              totalUsage: {
                inputTokenDetails: {},
                inputTokens: 1,
                outputTokenDetails: {},
                outputTokens: 2,
                totalTokens: 3
              },
              type: 'finish'
            }
          ]
        })) as StreamModelResponse
    })
  );

  const result = await processor.processTurn({
    assistantMessage: {
      summary: true,
      summarySource: 'compaction'
    },
    request: createRequest(),
    runId: run.id,
    sessionId: session.id,
    signal: new AbortController().signal,
    workspaceRoot: environment.workspaceRoot
  });

  assert.deepEqual(result, {
    finishReason: 'stop',
    kind: 'completed'
  });

  const [message] = messageService.listMessages(session.id);

  assert.equal(message?.summary, true);
  assert.equal(message?.content[0]?.type, 'summary');
  assert.equal(
    message?.content[0]?.type === 'summary'
      ? message.content[0].source
      : undefined,
    'compaction'
  );
});

test('SessionProcessor persists auto tool calls without executing local tools', async () => {
  const session = createSession();
  const run = agentRunService.createRun({ sessionId: session.id });
  const processor = new SessionProcessor(
    buildSessionProcessorDeps({
      streamModelResponse: (() =>
        createFakeStream({
          events: [
            {
              input: { filePath: 'src/index.ts' },
              toolCallId: 'model-call-read',
              toolName: 'read',
              type: 'tool-call'
            },
            {
              finishReason: 'tool-calls',
              response: {
                id: 'resp-tool',
                modelId: 'gpt-test',
                timestamp: new Date('2026-04-27T00:00:00.000Z')
              },
              type: 'finish-step',
              usage: {
                inputTokenDetails: {},
                inputTokens: 1,
                outputTokenDetails: {},
                outputTokens: 1,
                totalTokens: 2
              }
            }
          ]
        })) as StreamModelResponse
    })
  );
  const result = await processor.processTurn(
    createProcessTurnInput({
      request: createRequest({
        toolPolicies: {
          read: {
            approval: 'never',
            enabled: true,
            name: 'read',
            source: 'builtin'
          }
        }
      }),
      runId: run.id,
      sessionId: session.id
    })
  );

  assert.equal(result.kind, 'tool_calls');
  assert.equal(result.toolParts.length, 1);
  assert.equal(result.toolParts[0]?.state.status, 'pending');

  const messages = messageService.listMessages(session.id);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, 'assistant');
  assert.equal(messages[0]?.content[0]?.type, 'tool');
  assert.equal(
    messages[0]?.content[0]?.type === 'tool'
      ? messages[0].content[0].modelToolCallId
      : undefined,
    'model-call-read'
  );
  assert.deepEqual(
    sessionEventService
      .listAfterSequence(session.id, 0)
      .map((envelope) => envelope.event.type),
    ['message.created', 'message.part.created', 'message.completed']
  );
});

test('SessionProcessor pauses for approval-required tools and stores part checkpoint', async () => {
  const session = createSession();
  const run = agentRunService.createRun({ sessionId: session.id });
  const filePath = path.join(environment.workspaceRoot, 'src', 'index.ts');
  const content = await readFile(filePath, 'utf8');
  const fileStat = await stat(filePath);
  toolCallRepository.create({
    createdAt: '2026-04-27T00:00:00.000Z',
    id: 'snapshot-tool-call',
    input: { filePath: 'src/index.ts' },
    messageId: null,
    messagePartId: null,
    modelToolCallId: null,
    requiresApproval: false,
    runId: run.id,
    sessionId: session.id,
    status: 'completed',
    taskId: null,
    toolName: 'read',
    updatedAt: '2026-04-27T00:00:00.000Z'
  });
  await fileSnapshotService.createFromRead({
    sessionId: session.id,
    snapshot: {
      fullRead: true,
      lineCount: 1,
      mtimeMs: fileStat.mtimeMs,
      path: 'src/index.ts',
      readAt: '2026-04-27T00:00:00.000Z',
      sha256: createHash('sha256').update(content).digest('hex'),
      size: fileStat.size,
      truncated: false,
      version: 1
    },
    toolCallId: 'snapshot-tool-call'
  });
  const processor = new SessionProcessor(
    buildSessionProcessorDeps({
      streamModelResponse: (() =>
        createFakeStream({
          events: [
            {
              input: {
                content: 'export const ok = false;\n',
                filePath: 'src/index.ts'
              },
              toolCallId: 'model-call-write',
              toolName: 'write',
              type: 'tool-call'
            },
            {
              finishReason: 'tool-calls',
              response: {
                id: 'resp-approval',
                modelId: 'gpt-test',
                timestamp: new Date('2026-04-27T00:00:00.000Z')
              },
              type: 'finish-step',
              usage: {
                inputTokenDetails: {},
                inputTokens: 1,
                outputTokenDetails: {},
                outputTokens: 1,
                totalTokens: 2
              }
            }
          ]
        })) as StreamModelResponse
    })
  );
  const result = await processor.processTurn(
    createProcessTurnInput({
      request: createRequest({
        toolPolicies: {
          write: {
            approval: 'required',
            enabled: true,
            name: 'write',
            source: 'builtin'
          }
        }
      }),
      runId: run.id,
      sessionId: session.id
    })
  );

  assert.equal(result.kind, 'paused_for_approval');
  assert.equal(result.checkpoint.kind, 'waiting_approval');
  assert.ok(result.checkpoint.messageId);
  assert.ok(result.checkpoint.partId);
  assert.equal(result.checkpoint.modelToolCallId, 'model-call-write');
  assert.ok(result.checkpoint.toolCallId);
  assert.equal(result.approval.kind, 'write');
  assert.equal(result.approval.status, 'pending');
  assert.equal(result.toolCall.id, result.checkpoint.toolCallId);
  assert.equal(sessionService.getSession(session.id)?.status, 'planning');
  assert.deepEqual(
    sessionEventService
      .listAfterSequence(session.id, 0)
      .map((envelope) => envelope.event.type),
    ['message.created', 'message.part.created', 'message.completed']
  );
});

test('SessionProcessor converts approval payload generation failures into tool errors', async () => {
  const session = createSession();
  const run = agentRunService.createRun({ sessionId: session.id });
  const processor = new SessionProcessor(
    buildSessionProcessorDeps({
      prepareToolExecution: async () => {
        throw new Error(
          'File changed since it was last read. Read it again before modifying it.'
        );
      },
      streamModelResponse: (() =>
        createFakeStream({
          events: [
            {
              input: {
                content: 'hello\n',
                filePath: 'src/index.ts'
              },
              toolCallId: 'model-call-write-stale',
              toolName: 'write',
              type: 'tool-call'
            },
            {
              finishReason: 'tool-calls',
              response: {
                id: 'resp-stale-approval',
                modelId: 'gpt-test',
                timestamp: new Date('2026-04-27T00:00:00.000Z')
              },
              type: 'finish-step',
              usage: {
                inputTokenDetails: {},
                inputTokens: 1,
                outputTokenDetails: {},
                outputTokens: 1,
                totalTokens: 2
              }
            }
          ]
        })) as StreamModelResponse
    })
  );
  const result = await processor.processTurn(
    createProcessTurnInput({
      request: createRequest({
        toolPolicies: {
          write: {
            approval: 'required',
            enabled: true,
            name: 'write',
            source: 'builtin'
          }
        }
      }),
      runId: run.id,
      sessionId: session.id
    })
  );

  assert.equal(result.kind, 'tool_calls');
  assert.deepEqual(result.toolParts, []);

  const [message] = messageService.listMessages(session.id);
  const toolPart = message?.content.find((part) => part.type === 'tool');

  assert.equal(toolPart?.type, 'tool');
  assert.equal(
    toolPart?.type === 'tool' ? toolPart.state.status : undefined,
    'error'
  );
  assert.equal(
    toolPart?.type === 'tool' && toolPart.state.status === 'error'
      ? toolPart.state.errorText
      : undefined,
    'File changed since it was last read. Read it again before modifying it.'
  );

  const persistedToolCall =
    toolPart?.type === 'tool'
      ? toolCallRepository.getById(toolPart.toolCallId)
      : null;

  assert.equal(persistedToolCall?.status, 'failed');
  assert.equal(
    persistedToolCall?.errorText,
    'File changed since it was last read. Read it again before modifying it.'
  );
  assert.deepEqual(
    sessionEventService
      .listAfterSequence(session.id, 0)
      .map((envelope) => envelope.event.type),
    [
      'message.created',
      'message.part.created',
      'message.completed',
      'message.part.updated',
      'tool.failed'
    ]
  );
});

test('SessionProcessor fails multiple approval-required tools instead of creating ambiguous recovery', async () => {
  const session = createSession();
  const run = agentRunService.createRun({ sessionId: session.id });
  const processor = new SessionProcessor(
    buildSessionProcessorDeps({
      streamModelResponse: (() =>
        createFakeStream({
          events: [
            {
              input: {
                content: 'export const first = true;\n',
                filePath: 'src/first.ts'
              },
              toolCallId: 'model-call-write-1',
              toolName: 'write',
              type: 'tool-call'
            },
            {
              input: { command: 'pwd' },
              toolCallId: 'model-call-command-1',
              toolName: 'bash',
              type: 'tool-call'
            },
            {
              finishReason: 'tool-calls',
              response: {
                id: 'resp-multiple-approval',
                modelId: 'gpt-test',
                timestamp: new Date('2026-04-27T00:00:00.000Z')
              },
              type: 'finish-step',
              usage: {
                inputTokenDetails: {},
                inputTokens: 1,
                outputTokenDetails: {},
                outputTokens: 1,
                totalTokens: 2
              }
            }
          ]
        })) as StreamModelResponse
    })
  );
  const result = await processor.processTurn(
    createProcessTurnInput({
      request: createRequest({
        toolPolicies: {
          bash: {
            approval: 'required',
            enabled: true,
            name: 'bash',
            source: 'builtin'
          },
          write: {
            approval: 'required',
            enabled: true,
            name: 'write',
            source: 'builtin'
          }
        }
      }),
      runId: run.id,
      sessionId: session.id
    })
  );

  assert.deepEqual(result, {
    error: 'Multiple approval-required tool calls are not supported.',
    kind: 'failed'
  });

  const [message] = messageService.listMessages(session.id);
  const toolParts = message?.content.filter((part) => part.type === 'tool');

  assert.equal(message?.status, 'failed');
  assert.equal(toolParts?.length, 2);
  assert.deepEqual(
    toolParts?.map((part) => (part.type === 'tool' ? part.state.status : null)),
    ['error', 'error']
  );
  assert.equal(sessionService.getSession(session.id)?.status, 'planning');
});
