import { randomUUID } from 'node:crypto';
import type { CreateMessagePartInput, MessagePart } from '@opencode/shared';
import { ServiceError } from '../../../lib/service-error.js';
import { messagePartRepository } from '../../../repositories/message-part-repository.js';
import { messageRepository } from '../../../repositories/message-repository.js';

function normalizePart(
  input: CreateMessagePartInput & { runId?: string },
  index = 0
): MessagePart {
  const now = new Date().toISOString();
  const { runId: _runId, ...partInput } = input;

  if (!input.messageId || !input.sessionId) {
    throw new ServiceError('Message part is missing message/session ids.', 500);
  }

  return {
    ...partInput,
    createdAt: input.createdAt ?? now,
    id: input.id ?? randomUUID(),
    messageId: input.messageId,
    order: input.order ?? index,
    sessionId: input.sessionId,
    updatedAt: input.updatedAt ?? input.createdAt ?? now
  } as MessagePart;
}

export const messagePartService = {
  appendPart(input: CreateMessagePartInput & { runId?: string }): MessagePart {
    if (!input.messageId) {
      throw new ServiceError('Message part is missing message id.', 500);
    }

    const message = messageRepository.getById(input.messageId);

    if (!message) {
      throw new ServiceError(`Message not found: ${input.messageId}`, 404);
    }

    const part = normalizePart(input);

    return messagePartRepository.create({
      createdAt: part.createdAt,
      data: part,
      id: part.id,
      messageId: part.messageId,
      order: part.order,
      runId: input.runId ?? message.runId ?? null,
      sessionId: part.sessionId,
      type: part.type,
      updatedAt: part.updatedAt
    });
  },

  getPart(partId: string) {
    return messagePartRepository.getById(partId);
  },

  listParts(messageId: string) {
    return messagePartRepository.listByMessage(messageId);
  },

  updatePart(part: MessagePart): MessagePart | null {
    const updatedAt = new Date().toISOString();

    return messagePartRepository.update({
      data: {
        ...part,
        updatedAt
      } as MessagePart,
      id: part.id,
      updatedAt
    });
  }
};
