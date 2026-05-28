import type { MessageDto, SessionVariant } from '@opencode/shared';
import { messageService } from '../session/message/service.js';
import { sessionEventService } from '../session-events/event-service.js';

type RuntimeContextPersistInput = {
  key: string;
  parts: Array<{
    kind:
      | 'environment'
      | 'mode_state'
      | 'mode_transition'
      | 'nested_agents_memory'
      | 'plan_file';
    metadata?: Record<string, unknown>;
    text: string;
  }>;
  runId?: string;
  sessionId: string;
  variant?: SessionVariant;
};

function getRuntimeContextDedupKey(message: MessageDto) {
  for (const part of message.content) {
    if (
      part.type === 'runtime_context' &&
      typeof part.metadata?.runtimeContextDedupKey === 'string'
    ) {
      return part.metadata.runtimeContextDedupKey;
    }
  }

  return undefined;
}

export const runtimeContextMessageService = {
  findLatestRuntimeContextMessage(sessionId: string, dedupKey: string) {
    return [...messageService.listMessages(sessionId)]
      .reverse()
      .find((message) => getRuntimeContextDedupKey(message) === dedupKey);
  },

  listRuntimeContextMessages(sessionId: string) {
    return messageService
      .listMessages(sessionId)
      .filter((message) =>
        message.content.some((part) => part.type === 'runtime_context')
      );
  },

  persistRuntimeContextMessage(input: RuntimeContextPersistInput): MessageDto {
    const existing = this.findLatestRuntimeContextMessage(
      input.sessionId,
      input.key
    );

    if (existing) {
      return existing;
    }

    const message = messageService.createMessage({
      content: input.parts.map((part) => ({
        kind: part.kind,
        metadata: {
          ...(part.metadata ?? {}),
          runtimeContextDedupKey: input.key
        },
        synthetic: true,
        text: part.text,
        type: 'runtime_context' as const
      })),
      role: 'user',
      runId: input.runId,
      runtime: {
        format: { type: 'text' },
        runtimeContextInjected: true,
        variant: input.variant
      },
      sessionId: input.sessionId,
      status: 'completed'
    });

    sessionEventService.append({
      message,
      sessionId: input.sessionId,
      type: 'message.created'
    });

    for (const part of message.content) {
      sessionEventService.append({
        messageId: message.id,
        part,
        runId: input.runId,
        sessionId: input.sessionId,
        type: 'message.part.created'
      });
    }

    sessionEventService.append({
      messageId: message.id,
      runId: input.runId,
      sessionId: input.sessionId,
      type: 'message.completed'
    });

    return message;
  },

  persistPlanFileReference(input: {
    filePath: string;
    planId: string;
    runId?: string;
    sessionId: string;
    variant?: SessionVariant;
  }) {
    return this.persistRuntimeContextMessage({
      key: `plan_file:${input.planId}:${input.filePath}`,
      parts: [
        {
          kind: 'plan_file',
          metadata: {
            filePath: input.filePath,
            planId: input.planId
          },
          text: `Current plan file path: ${input.filePath}`
        }
      ],
      runId: input.runId,
      sessionId: input.sessionId,
      variant: input.variant
    });
  }
};
