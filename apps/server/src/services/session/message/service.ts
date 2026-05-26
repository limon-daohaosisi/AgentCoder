import { randomUUID } from 'node:crypto';
import type {
  CreateMessagePartInput,
  MessageDto,
  MessagePart,
  MessageRuntimeMetadata,
  MessageStatus,
  TokenUsageDto
} from '@opencode/shared';
import { Database } from '../../../db/runtime.js';
import { ServiceError } from '../../../lib/service-error.js';
import { messageRepository } from '../../../repositories/message-repository.js';
import { messagePartRepository } from '../../../repositories/message-part-repository.js';
import { sessionRepository } from '../../../repositories/session-repository.js';

type CreateMessageInput = {
  agentName?: string;
  content?: CreateMessagePartInput[];
  createdAt?: string;
  errorText?: string;
  finishReason?: string;
  id?: string;
  model?: {
    modelId: string;
    providerId: string;
  };
  parentMessageId?: string;
  providerMetadata?: Record<string, unknown>;
  role: MessageDto['role'];
  runtime?: MessageRuntimeMetadata;
  runId?: string;
  sessionId: string;
  status?: MessageStatus;
  summary?: boolean;
  taskId?: string;
  tokenUsage?: TokenUsageDto;
};

type UpdateMessageRuntimeInput = {
  errorText?: null | string;
  finishReason?: null | string;
  id: string;
  modelResponseId?: null | string;
  providerMetadata?: null | Record<string, unknown>;
  status?: MessageStatus;
  tokenUsage?: null | TokenUsageDto;
};

function normalizePart(
  input: CreateMessagePartInput & { runId?: string },
  index: number
): MessagePart {
  const now = new Date().toISOString();
  const { runId: _runId, ...partInput } = input;
  const base = {
    createdAt: input.createdAt ?? now,
    id: input.id ?? randomUUID(),
    messageId: input.messageId,
    order: input.order ?? index,
    sessionId: input.sessionId,
    updatedAt: input.updatedAt ?? input.createdAt ?? now
  };

  return {
    ...partInput,
    ...base
  } as MessagePart;
}

export const messageService = {
  createMessage(input: CreateMessageInput): MessageDto {
    return Database.transaction(() => {
      const session = sessionRepository.getById(input.sessionId);

      if (!session) {
        throw new ServiceError(`Session not found: ${input.sessionId}`, 404);
      }

      const now = input.createdAt ?? new Date().toISOString();
      const messageId = input.id ?? randomUUID();
      const parts = (input.content ?? []).map((part, index) => {
        // createMessage owns the DB message id, so part inputs may omit it.
        return normalizePart(
          {
            ...part,
            messageId,
            sessionId: input.sessionId
          },
          index
        );
      });

      const message = messageRepository.create({
        agentName: input.agentName ?? null,
        compactedByMessageId: null,
        content: [],
        createdAt: now,
        errorText: input.errorText ?? null,
        finishReason: input.finishReason ?? null,
        id: messageId,
        kind: 'message',
        modelId: input.model?.modelId ?? null,
        modelProviderId: input.model?.providerId ?? null,
        modelResponseId: null,
        parentMessageId: input.parentMessageId ?? null,
        providerMetadata: input.providerMetadata,
        role: input.role,
        runtime: input.runtime,
        runId: input.runId ?? null,
        sessionId: input.sessionId,
        status: input.status ?? 'completed',
        summary: input.summary,
        taskId: input.taskId ?? null,
        tokenUsage: input.tokenUsage,
        updatedAt: now
      });

      for (const part of parts) {
        messagePartRepository.create({
          createdAt: part.createdAt,
          data: part,
          id: part.id,
          messageId: part.messageId,
          order: part.order,
          runId: input.runId ?? null,
          sessionId: part.sessionId,
          type: part.type,
          updatedAt: part.updatedAt
        });
      }

      return {
        ...message,
        content: parts
      };
    });
  },

  listMessages(sessionId: string, options?: { includeReverted?: boolean }) {
    const messages = messageRepository
      .listBySession(sessionId)
      .map((message) => ({
        ...message,
        content: messagePartRepository.listByMessage(message.id)
      }));

    if (options?.includeReverted) {
      return messages;
    }

    const session = sessionRepository.getById(sessionId);
    const targetMessageId = session?.revert?.targetMessageId;

    if (!targetMessageId) {
      return messages;
    }

    const targetIndex = messages.findIndex(
      (message) => message.id === targetMessageId
    );

    if (targetIndex === -1) {
      return messages;
    }

    const visiblePrefix = messages.slice(0, targetIndex);
    const continuedAt = session?.revert?.continuedAt;

    if (!continuedAt) {
      return visiblePrefix;
    }

    const visibleSuffix = messages.filter(
      (message) => message.createdAt >= continuedAt
    );

    return [...visiblePrefix, ...visibleSuffix];
  },

  updateMessageContent(id: string, content: MessagePart[]) {
    const message = messageRepository.updateContent(id, content);

    return message
      ? {
          ...message,
          content
        }
      : null;
  },

  updateMessageRuntime(input: UpdateMessageRuntimeInput) {
    const message = messageRepository.updateRuntime({
      ...input,
      updatedAt: new Date().toISOString()
    });

    return message
      ? {
          ...message,
          content: messagePartRepository.listByMessage(message.id)
        }
      : null;
  },

  markMessagesCompacted(input: {
    compactedByMessageId: string;
    messageIds: string[];
  }) {
    return messageRepository.markCompacted(input).map((message) => ({
      ...message,
      content: messagePartRepository.listByMessage(message.id)
    }));
  }
};
