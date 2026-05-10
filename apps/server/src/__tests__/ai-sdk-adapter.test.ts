import {
  ContextBuilder,
  bashInputSchema,
  DEFAULT_TOOL_OUTPUT_POLICY,
  readInputSchema,
  toAiSdkMessages,
  toAiSdkToolSet,
  toToolPolicies,
  type ContextPart,
  type ResolvedTool
} from '@opencode/agent';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';

const {
  environment,
  messageService,
  partService,
  sessionService,
  workspaceService
} = dbTestContext;

function createSession() {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });

  return sessionService.createSession({
    goalText: 'Exercise AI SDK adapter behavior',
    workspaceId: workspace.id
  });
}

beforeEach(() => {
  resetTestDatabase();
});

test('ContextBuilder and AI SDK adapter rebuild tool call/result context from parts', () => {
  const session = createSession();
  const user = messageService.createMessage({
    content: [{ text: 'Read src/index.ts', type: 'text' }],
    role: 'user',
    sessionId: session.id
  });
  const assistant = messageService.createMessage({
    content: [{ text: 'I will inspect the file.', type: 'text' }],
    role: 'assistant',
    sessionId: session.id
  });

  partService.appendPart({
    messageId: assistant.id,
    modelToolCallId: 'model-call-1',
    order: 1,
    sessionId: session.id,
    state: {
      completedAt: '2026-04-27T00:00:01.000Z',
      input: { filePath: 'src/index.ts' },
      outputText: 'export const ok = true;\n',
      payload: {
        content: 'export const ok = true;\n',
        filePath: 'src/index.ts'
      },
      startedAt: '2026-04-27T00:00:00.000Z',
      status: 'completed'
    },
    toolCallId: 'tool-call-1',
    toolName: 'read',
    type: 'tool'
  });

  const builder = new ContextBuilder({
    getSession: (sessionId) => sessionService.getSession(sessionId),
    listMessages: (sessionId) => messageService.listMessages(sessionId)
  });
  const context = builder.build({
    sessionId: session.id,
    workspaceRoot: environment.workspaceRoot
  });
  const messages = toAiSdkMessages(context);

  assert.equal(context.lastUser.messageId, user.id);
  assert.deepEqual(messages, [
    {
      content: [{ text: 'Read src/index.ts', type: 'text' }],
      role: 'user'
    },
    {
      content: [
        { text: 'I will inspect the file.', type: 'text' },
        {
          input: { filePath: 'src/index.ts' },
          toolCallId: 'model-call-1',
          toolName: 'read',
          type: 'tool-call'
        }
      ],
      role: 'assistant'
    },
    {
      content: [
        {
          output: {
            type: 'json',
            value: {
              content: 'export const ok = true;\n',
              filePath: 'src/index.ts'
            }
          },
          toolCallId: 'model-call-1',
          toolName: 'read',
          type: 'tool-result'
        }
      ],
      role: 'tool'
    }
  ]);
});

test('Tool adapter exposes manual AI SDK tools and separate approval policies', () => {
  const resolvedTools: ResolvedTool[] = [
    {
      approval: 'never',
      description: 'Read a file',
      enabled: true,
      inputSchema: readInputSchema,
      name: 'read',
      source: 'builtin'
    },
    {
      approval: 'required',
      description: 'Run a command',
      enabled: true,
      inputSchema: bashInputSchema,
      name: 'bash',
      source: 'builtin'
    }
  ];
  const toolSet = toAiSdkToolSet({
    executionMode: 'manual',
    tools: resolvedTools
  });
  const policies = toToolPolicies(resolvedTools);

  assert.ok(toolSet.read);
  assert.equal(typeof toolSet.read, 'object');
  assert.equal('execute' in toolSet.read, false);
  assert.equal(policies.bash?.approval, 'required');
});

test('AI SDK adapter applies tool-level json field visibility for builtin read', () => {
  const session = createSession();

  messageService.createMessage({
    content: [{ text: 'Run tools', type: 'text' }],
    role: 'user',
    sessionId: session.id
  });
  const assistant = messageService.createMessage({
    content: [],
    role: 'assistant',
    sessionId: session.id
  });

  partService.appendPart({
    messageId: assistant.id,
    modelToolCallId: 'model-call-json',
    order: 0,
    sessionId: session.id,
    state: {
      completedAt: '2026-04-27T00:00:01.000Z',
      input: { filePath: 'src/index.ts' },
      outputText: 'Visible fallback text',
      payload: {
        absolutePath: '/secret/workspace/src/index.ts',
        content: 'export const ok = true;\n',
        filePath: 'src/index.ts',
        fullRead: true,
        limit: 2000,
        offset: 1,
        totalLines: 12,
        truncated: false,
        type: 'file'
      },
      startedAt: '2026-04-27T00:00:00.000Z',
      status: 'completed'
    },
    toolCallId: 'tool-call-json',
    toolName: 'read',
    type: 'tool'
  });

  const builder = new ContextBuilder({
    getSession: (sessionId) => sessionService.getSession(sessionId),
    listMessages: (sessionId) => messageService.listMessages(sessionId)
  });
  const messages = toAiSdkMessages(
    builder.build({
      sessionId: session.id,
      workspaceRoot: environment.workspaceRoot
    })
  );
  const toolMessage = messages.find((message) => message.role === 'tool');

  assert.equal(toolMessage?.role, 'tool');
  assert.deepEqual(
    toolMessage?.role === 'tool' ? toolMessage.content : undefined,
    [
      {
        output: {
          type: 'json',
          value: {
            content: 'export const ok = true;\n',
            filePath: 'src/index.ts',
            fullRead: true,
            limit: 2000,
            offset: 1,
            totalLines: 12,
            truncated: false,
            type: 'file'
          }
        },
        toolCallId: 'model-call-json',
        toolName: 'read',
        type: 'tool-result'
      }
    ]
  );
});

test('AI SDK adapter exposes attachments only when output policy allows them', () => {
  const messages = toAiSdkMessages({
    debug: { skippedParts: [] },
    estimate: { chars: 0, tokens: 0 },
    lastUser: {
      agentName: 'opencode',
      messageId: 'user-1',
      model: { modelId: 'gpt-4.1-mini', providerId: 'openai' }
    },
    messages: [
      {
        parts: [
          { sourcePartId: 'user-part-1', text: 'Inspect result', type: 'text' }
        ],
        role: 'user',
        sourceMessageId: 'user-1'
      },
      {
        parts: [
          {
            attachments: [
              {
                filename: 'result.txt',
                mime: 'text/plain',
                url: 'file:///tmp/result.txt'
              },
              {
                filename: 'secret.bin',
                mime: 'application/octet-stream',
                url: 'file:///tmp/secret.bin'
              }
            ],
            input: { filePath: 'result.txt' },
            modelToolCallId: 'model-call-file',
            outputPolicy: {
              attachments: {
                allowedMimePrefixes: ['text/'],
                maxAttachments: 1,
                visibleToModel: true
              },
              errors: { visibleToModel: 'error_text_only' },
              mode: 'content',
              text: { maxChars: 1000, visibleToModel: true }
            },
            outputText: 'See attached result.',
            payload: { hidden: true },
            sourcePartId: 'tool-part-file',
            toolCallId: 'tool-call-file',
            toolName: 'read',
            type: 'tool'
          } satisfies Extract<ContextPart, { type: 'tool' }>
        ],
        role: 'assistant',
        sourceMessageId: 'assistant-1'
      }
    ],
    system: []
  });

  assert.deepEqual(messages.at(-1), {
    content: [
      {
        output: {
          type: 'content',
          value: [
            { text: 'See attached result.', type: 'text' },
            {
              filename: 'result.txt',
              type: 'file-url',
              url: 'file:///tmp/result.txt'
            }
          ]
        },
        toolCallId: 'model-call-file',
        toolName: 'read',
        type: 'tool-result'
      }
    ],
    role: 'tool'
  });
});

test('ContextBuilder repairs dangling tools outside active approval waits', () => {
  const session = createSession();
  const now = '2026-04-27T00:00:00.000Z';

  messageService.createMessage({
    content: [{ text: 'Read file', type: 'text' }],
    createdAt: now,
    role: 'user',
    sessionId: session.id
  });
  const assistant = messageService.createMessage({
    content: [],
    createdAt: now,
    role: 'assistant',
    sessionId: session.id
  });

  partService.appendPart({
    messageId: assistant.id,
    modelToolCallId: 'model-call-dangling',
    order: 0,
    sessionId: session.id,
    state: {
      input: { filePath: 'src/index.ts' },
      status: 'pending'
    },
    toolCallId: 'tool-call-dangling',
    toolName: 'read',
    type: 'tool'
  });

  let repaired = false;
  const builder = new ContextBuilder({
    getSession: (sessionId) => sessionService.getSession(sessionId),
    listMessages: (sessionId) => messageService.listMessages(sessionId),
    repairDanglingToolPart: ({ part }) => {
      repaired = true;
      return part;
    }
  });
  const context = builder.build({
    sessionId: session.id,
    workspaceRoot: environment.workspaceRoot
  });
  const toolPart = context.messages[1]?.parts[0];

  assert.equal(repaired, true);
  assert.equal(toolPart?.type, 'tool');
  assert.equal(
    toolPart?.type === 'tool' ? toolPart.errorReason : undefined,
    'interrupted'
  );
  assert.equal(
    context.debug.skippedParts.some(
      (part) => part.reason === 'tool_interrupted_repaired'
    ),
    true
  );
});

test('AI SDK adapter rebuilds failed approved tool results as error-text tool messages', () => {
  const session = createSession();

  messageService.createMessage({
    content: [{ text: 'Edit src/index.ts', type: 'text' }],
    role: 'user',
    sessionId: session.id
  });
  const assistant = messageService.createMessage({
    content: [],
    role: 'assistant',
    sessionId: session.id
  });

  partService.appendPart({
    messageId: assistant.id,
    modelToolCallId: 'model-call-edit-failed',
    order: 0,
    sessionId: session.id,
    state: {
      completedAt: '2026-04-27T00:00:01.000Z',
      errorText:
        'File changed since it was last read. Read it again before modifying it.',
      input: {
        filePath: 'src/index.ts',
        newString: 'hello',
        oldString: 'updated',
        replaceAll: false
      },
      payload: {
        error:
          'File changed since it was last read. Read it again before modifying it.',
        ok: false
      },
      reason: 'tool_error',
      startedAt: '2026-04-27T00:00:00.000Z',
      status: 'error'
    },
    toolCallId: 'tool-call-edit-failed',
    toolName: 'edit',
    type: 'tool'
  });

  const builder = new ContextBuilder({
    getSession: (sessionId) => sessionService.getSession(sessionId),
    listMessages: (sessionId) => messageService.listMessages(sessionId)
  });
  const messages = toAiSdkMessages(
    builder.build({
      sessionId: session.id,
      workspaceRoot: environment.workspaceRoot
    })
  );

  assert.deepEqual(messages, [
    {
      content: [{ text: 'Edit src/index.ts', type: 'text' }],
      role: 'user'
    },
    {
      content: [
        {
          input: {
            filePath: 'src/index.ts',
            newString: 'hello',
            oldString: 'updated',
            replaceAll: false
          },
          toolCallId: 'model-call-edit-failed',
          toolName: 'edit',
          type: 'tool-call'
        }
      ],
      role: 'assistant'
    },
    {
      content: [
        {
          output: {
            type: 'error-text',
            value:
              'File changed since it was last read. Read it again before modifying it.'
          },
          toolCallId: 'model-call-edit-failed',
          toolName: 'edit',
          type: 'tool-result'
        }
      ],
      role: 'tool'
    }
  ]);
});

test('AI SDK adapter preserves execution-denied output when policy requests it', () => {
  const messages = toAiSdkMessages({
    debug: { skippedParts: [] },
    estimate: { chars: 0, tokens: 0 },
    lastUser: {
      agentName: 'opencode',
      messageId: 'user-2',
      model: { modelId: 'gpt-4.1-mini', providerId: 'openai' }
    },
    messages: [
      {
        parts: [
          {
            sourcePartId: 'user-part-2',
            text: 'Run restricted tool',
            type: 'text'
          }
        ],
        role: 'user',
        sourceMessageId: 'user-2'
      },
      {
        parts: [
          {
            errorReason: 'execution_denied',
            errorText: 'Approval rejected by user',
            input: { command: 'rm -rf tmp' },
            modelToolCallId: 'model-call-denied',
            outputPolicy: {
              ...DEFAULT_TOOL_OUTPUT_POLICY,
              errors: { visibleToModel: 'execution_denied_only' }
            },
            sourcePartId: 'tool-part-denied',
            toolCallId: 'tool-call-denied',
            toolName: 'bash',
            type: 'tool'
          } satisfies Extract<ContextPart, { type: 'tool' }>
        ],
        role: 'assistant',
        sourceMessageId: 'assistant-2'
      }
    ],
    system: []
  });

  assert.deepEqual(messages.at(-1), {
    content: [
      {
        output: {
          reason: 'Approval rejected by user',
          type: 'execution-denied'
        },
        toolCallId: 'model-call-denied',
        toolName: 'bash',
        type: 'tool-result'
      }
    ],
    role: 'tool'
  });
});
