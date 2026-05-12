import { SessionCompaction, type StreamModelResponse } from '@opencode/agent';
import { SessionInteractionService } from '../services/agent/interaction-service.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import type { MessagePart } from '@opencode/shared';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';
import { approvalRepository } from '../repositories/approval-repository.js';
import { artifactRepository } from '../repositories/artifact-repository.js';
import { buildSessionCompactionDeps } from '../wiring/agent.js';

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
    toolName: 'bash',
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
      toolName: 'bash',
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
    kind: 'bash',
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

test('manual compact does not auto-continue the original task and restores recent read context', async () => {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });
  const session = sessionService.createSession({
    goalText: 'Compact the current durable transcript',
    workspaceId: workspace.id
  });
  const run = dbTestContext.agentRunService.createRun({
    sessionId: session.id
  });

  messageService.createMessage({
    content: [{ text: 'Review src/index.ts and keep going', type: 'text' }],
    role: 'user',
    runId: run.id,
    sessionId: session.id,
    status: 'completed'
  });
  const assistant = messageService.createMessage({
    content: [],
    role: 'assistant',
    runId: run.id,
    sessionId: session.id,
    status: 'completed'
  });

  partService.createToolPartWithToolCall({
    part: {
      createdAt: '2026-05-10T00:00:00.000Z',
      id: 'recent-read-part',
      messageId: assistant.id,
      modelToolCallId: 'recent-read-model-call',
      order: 0,
      sessionId: session.id,
      state: {
        completedAt: '2026-05-10T00:00:02.000Z',
        input: { filePath: 'src/index.ts' },
        outputText:
          '<path>src/index.ts</path>\n<type>file</type>\n<content>\n1: export const recovered = true;\n</content>',
        payload: {
          content: '1: export const recovered = true;',
          filePath: 'src/index.ts',
          fullRead: true,
          type: 'file'
        },
        startedAt: '2026-05-10T00:00:01.000Z',
        status: 'completed'
      },
      toolCallId: 'recent-read-tool-call',
      toolName: 'read',
      type: 'tool',
      updatedAt: '2026-05-10T00:00:02.000Z'
    },
    toolCall: {
      createdAt: '2026-05-10T00:00:00.000Z',
      id: 'recent-read-tool-call',
      input: { filePath: 'src/index.ts' },
      messageId: assistant.id,
      messagePartId: 'recent-read-part',
      modelToolCallId: 'recent-read-model-call',
      requiresApproval: false,
      runId: run.id,
      sessionId: session.id,
      status: 'completed',
      taskId: null,
      toolName: 'read',
      updatedAt: '2026-05-10T00:00:02.000Z'
    }
  });

  const interactionService = new SessionInteractionService(
    undefined,
    undefined,
    {
      async runManualCompaction() {
        const requestMessage = messageService.createMessage({
          content: [
            {
              auto: false,
              reason: 'manual',
              targetMessageId: assistant.id,
              type: 'compaction'
            }
          ],
          role: 'user',
          runId: run.id,
          sessionId: session.id,
          status: 'completed'
        });
        const summaryMessage = messageService.createMessage({
          content: [
            {
              source: 'compaction',
              text: 'Current Objective\n- Compact the current durable transcript',
              type: 'summary'
            }
          ],
          role: 'assistant',
          runId: run.id,
          sessionId: session.id,
          status: 'completed',
          summary: true
        });
        const postContextMessage = messageService.createMessage({
          content: [
            {
              metadata: { kind: 'post_compact_context' },
              synthetic: true,
              text: 'Post-compact working set:\n\nRecovered recent read for src/index.ts:\n\n<path>src/index.ts</path>\n<type>file</type>\n<content>\n1: export const recovered = true;\n</content>',
              type: 'text'
            }
          ],
          role: 'assistant',
          runId: run.id,
          sessionId: session.id,
          status: 'completed'
        });

        return {
          kind: 'completed' as const,
          postContextMessageId: postContextMessage.id,
          requestMessageId: requestMessage.id,
          summaryMessageId: summaryMessage.id
        };
      }
    } as never
  );

  const result = await interactionService.manualCompact({
    sessionId: session.id
  });

  assert.equal(result.compacted, true);

  const messages = messageService.listMessages(session.id);
  const postCompactMessage = messages.find((message) =>
    message.content.some(
      (part) =>
        part.type === 'text' &&
        part.synthetic === true &&
        part.metadata?.kind === 'post_compact_context'
    )
  );

  assert.ok(postCompactMessage);
  assert.match(
    postCompactMessage?.content[0]?.type === 'text'
      ? postCompactMessage.content[0].text
      : '',
    /Recovered recent read for src\/index\.ts:/
  );
  assert.match(
    postCompactMessage?.content[0]?.type === 'text'
      ? postCompactMessage.content[0].text
      : '',
    /export const recovered = true/
  );
  assert.equal(sessionService.getSession(session.id)?.status, 'idle');
});

test('manual compact skips restoring stale recent reads when a newer snapshot exists', async () => {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });
  const session = sessionService.createSession({
    goalText: 'Compact only fresh reads',
    workspaceId: workspace.id
  });
  const run = dbTestContext.agentRunService.createRun({
    sessionId: session.id
  });

  messageService.createMessage({
    content: [{ text: 'Review src/index.ts', type: 'text' }],
    role: 'user',
    runId: run.id,
    sessionId: session.id,
    status: 'completed'
  });
  const assistant = messageService.createMessage({
    content: [],
    role: 'assistant',
    runId: run.id,
    sessionId: session.id,
    status: 'completed'
  });

  partService.createToolPartWithToolCall({
    part: {
      createdAt: '2026-05-10T00:00:00.000Z',
      id: 'stale-read-part',
      messageId: assistant.id,
      modelToolCallId: 'stale-read-model-call',
      order: 0,
      sessionId: session.id,
      state: {
        completedAt: '2026-05-10T00:00:02.000Z',
        input: { filePath: 'src/index.ts' },
        metadata: { snapshotArtifactId: 'old-snapshot-artifact' },
        outputText:
          '<path>src/index.ts</path>\n<type>file</type>\n<content>\n1: export const stale = true;\n</content>',
        payload: {
          content: '1: export const stale = true;',
          filePath: 'src/index.ts',
          fullRead: true,
          snapshotArtifactId: 'old-snapshot-artifact',
          type: 'file'
        },
        startedAt: '2026-05-10T00:00:01.000Z',
        status: 'completed'
      },
      toolCallId: 'stale-read-tool-call',
      toolName: 'read',
      type: 'tool',
      updatedAt: '2026-05-10T00:00:02.000Z'
    },
    toolCall: {
      createdAt: '2026-05-10T00:00:00.000Z',
      id: 'stale-read-tool-call',
      input: { filePath: 'src/index.ts' },
      messageId: assistant.id,
      messagePartId: 'stale-read-part',
      modelToolCallId: 'stale-read-model-call',
      requiresApproval: false,
      runId: run.id,
      sessionId: session.id,
      status: 'completed',
      taskId: null,
      toolName: 'read',
      updatedAt: '2026-05-10T00:00:02.000Z'
    }
  });

  artifactRepository.create({
    createdAt: '2026-05-10T00:00:02.000Z',
    id: 'old-snapshot-artifact',
    kind: 'file_snapshot',
    payload: {
      fullRead: true,
      mtimeMs: 1,
      path: 'src/index.ts',
      readAt: '2026-05-10T00:00:02.000Z',
      sha256: 'old-hash',
      size: 10,
      truncated: false,
      version: 1
    },
    sessionId: session.id,
    title: 'src/index.ts',
    toolCallId: 'stale-read-tool-call'
  });
  artifactRepository.create({
    createdAt: '2026-05-10T00:05:00.000Z',
    id: 'new-snapshot-artifact',
    kind: 'file_snapshot',
    payload: {
      fullRead: true,
      mtimeMs: 2,
      path: 'src/index.ts',
      readAt: '2026-05-10T00:05:00.000Z',
      sha256: 'new-hash',
      size: 20,
      truncated: false,
      version: 1
    },
    sessionId: session.id,
    title: 'src/index.ts',
    toolCallId: 'stale-read-tool-call'
  });

  const interactionService = new SessionInteractionService(
    undefined,
    undefined,
    new SessionCompaction(
      buildSessionCompactionDeps({
        processTurn: undefined,
        streamModelResponse: (() => ({
          fullStream: {
            async *[Symbol.asyncIterator]() {
              yield {
                id: 'compact-summary-stale-read',
                text: '<summary>Current Objective\n- Keep only fresh context</summary>',
                type: 'text-delta'
              };
              yield {
                response: { id: 'compact-response-stale-read' },
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
      })
    )
  );

  const result = await interactionService.manualCompact({
    sessionId: session.id
  });

  assert.equal(result.compacted, true);

  const postCompactMessage = messageService
    .listMessages(session.id)
    .find((message) =>
      message.content.some(
        (part) =>
          part.type === 'text' &&
          part.synthetic === true &&
          part.metadata?.kind === 'post_compact_context'
      )
    );

  assert.equal(postCompactMessage, undefined);
});

test('manual compact inherits workspace AGENTS.md in compact system prompt', async () => {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });
  const session = sessionService.createSession({
    goalText: 'Manual compact should see project memory',
    workspaceId: workspace.id
  });

  writeFileSync(
    path.join(environment.workspaceRoot, 'AGENTS.md'),
    '# Workspace Policy\nPreserve test constraints.\n'
  );

  messageService.createMessage({
    content: [{ text: 'Summarize current progress', type: 'text' }],
    role: 'user',
    sessionId: session.id
  });

  const seenSystems: string[] = [];
  const interactionService = new SessionInteractionService(
    undefined,
    undefined,
    new SessionCompaction(
      buildSessionCompactionDeps({
        processTurn: undefined,
        streamModelResponse: ((request: Parameters<StreamModelResponse>[0]) => {
          seenSystems.push(request.system);

          return {
            fullStream: {
              async *[Symbol.asyncIterator]() {
                yield {
                  id: 'compact-summary-with-memory',
                  text: '<summary>Current Objective\n- Preserve constraints</summary>',
                  type: 'text-delta'
                };
                yield {
                  response: { id: 'compact-response-with-memory' },
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
      })
    )
  );

  const result = await interactionService.manualCompact({
    sessionId: session.id
  });

  assert.equal(result.compacted, true);
  assert.equal(seenSystems.length, 1);
  assert.match(seenSystems[0] ?? '', /<project-memory source="AGENTS.md"/);
  assert.match(seenSystems[0] ?? '', /Preserve test constraints\./);
  assert.match(seenSystems[0] ?? '', /Do not call tools\./);
});
