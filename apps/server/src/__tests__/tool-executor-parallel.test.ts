import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolExecutor, type ToolExecutorDeps } from '@opencode/agent';
import type { MessagePart, SessionEvent, ToolCallDto } from '@opencode/shared';

type ToolPart = Extract<MessagePart, { type: 'tool' }>;

function createPendingToolPart(input: {
  description: string;
  id: string;
  toolCallId: string;
  toolName: ToolPart['toolName'];
}): ToolPart {
  return {
    createdAt: '2026-05-30T00:00:00.000Z',
    id: input.id,
    messageId: 'assistant-message-1',
    modelToolCallId: `model-${input.toolCallId}`,
    order: 0,
    sessionId: 'session-1',
    state: {
      input:
        input.toolName === 'agent'
          ? {
              description: input.description,
              prompt: `Inspect ${input.description}`,
              subagentType: 'explore'
            }
          : {},
      status: 'pending'
    },
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    type: 'tool',
    updatedAt: '2026-05-30T00:00:00.000Z'
  };
}

test('ToolExecutor runs consecutive standalone concurrency-safe tools in parallel', async () => {
  const events: SessionEvent[] = [];
  const starts: string[] = [];

  const deps: ToolExecutorDeps = {
    appendSessionEvent(event) {
      events.push(event);
    },
    getMessagePart() {
      return null;
    },
    now: () => '2026-05-30T00:00:00.000Z',
    persist(callback) {
      return callback();
    },
    services: {
      subagentRun: async (input) => {
        starts.push(input.description);
        await new Promise((resolve) => setTimeout(resolve, 80));

        return {
          childRunId: `run-${input.description}`,
          sessionId: `session-${input.description}`,
          status: 'completed',
          summaryText: `summary:${input.description}`,
          title: `${input.description} (@explore subagent)`
        };
      }
    },
    updateToolPartWithToolCall(input) {
      const part: ToolPart =
        input.toolCall.status === 'running'
          ? {
              ...input.part,
              state: {
                input: input.part.state.input,
                startedAt: input.toolCall.startedAt!,
                status: 'running'
              }
            }
          : input.toolCall.status === 'completed'
            ? {
                ...input.part,
                state: {
                  completedAt: input.toolCall.completedAt!,
                  input: input.part.state.input,
                  metadata: {
                    subagentType: 'explore'
                  },
                  outputText: `summary:${input.part.toolCallId}`,
                  payload: input.toolCall.result ?? undefined,
                  startedAt: input.toolCall.startedAt!,
                  status: 'completed'
                }
              }
            : input.part;

      return {
        part,
        toolCall: {
          createdAt: '2026-05-30T00:00:00.000Z',
          id: input.toolCall.id,
          input: {},
          messageId: 'assistant-message-1',
          messagePartId: input.part.id,
          sessionId: 'session-1',
          status: input.toolCall.status,
          toolName: input.part.toolName,
          updatedAt: '2026-05-30T00:00:00.000Z'
        } as ToolCallDto
      };
    }
  };

  const executor = new ToolExecutor(deps);
  const startedAt = Date.now();
  const result = await executor.executePendingToolParts({
    parts: [
      createPendingToolPart({
        description: 'agent-1',
        id: 'part-agent-1',
        toolCallId: 'tool-agent-1',
        toolName: 'agent'
      }),
      createPendingToolPart({
        description: 'agent-2',
        id: 'part-agent-2',
        toolCallId: 'tool-agent-2',
        toolName: 'agent'
      })
    ],
    runId: 'run-parent-1',
    sessionId: 'session-1',
    signal: new AbortController().signal,
    workspaceRoot: '/workspace'
  });
  const elapsedMs = Date.now() - startedAt;

  assert.deepEqual(result, {
    executedPartIds: ['part-agent-1', 'part-agent-2'],
    kind: 'completed'
  });
  assert.deepEqual(starts, ['agent-1', 'agent-2']);
  assert.ok(
    elapsedMs < 140,
    `expected parallel execution under 140ms, got ${elapsedMs}ms`
  );
  assert.equal(
    events.filter((event) => event.type === 'tool.running').length,
    2
  );
});
