import type {
  MessagePart,
  ToolCallDto,
  ToolCallStatus
} from '@opencode/shared';
import { ServiceError } from '../../lib/service-error.js';
import { toolStateRepository } from '../../repositories/tool-state-repository.js';

type ToolPart = Extract<MessagePart, { type: 'tool' }>;

type UpdateToolPartWithToolCallInput = {
  part: ToolPart;
  toolCall: {
    completedAt?: null | string;
    errorText?: null | string;
    id: string;
    result?: null | Record<string, unknown>;
    startedAt?: null | string;
    status: ToolCallStatus;
    updatedAt?: string;
  };
};

type CreateToolPartWithToolCallInput = {
  part: ToolPart;
  toolCall: {
    createdAt: string;
    id: string;
    input: Record<string, unknown>;
    messageId: null | string;
    messagePartId: string;
    modelToolCallId: string;
    providerMetadata?: Record<string, unknown>;
    requiresApproval: boolean;
    runId?: null | string;
    sessionId: string;
    startedAt?: string;
    status: ToolCallStatus;
    taskId: null | string;
    toolName: ToolCallDto['toolName'];
    updatedAt: string;
  };
};

function assertToolPartMatchesToolCall(input: {
  part: ToolPart;
  toolCall: {
    id: string;
    messageId?: null | string;
    messagePartId?: null | string;
    modelToolCallId?: null | string;
    sessionId?: string;
    toolName?: string;
  };
}) {
  if (input.part.toolCallId !== input.toolCall.id) {
    throw new ServiceError('ToolPart/tool_calls id mismatch.', 500);
  }

  if (
    input.toolCall.messagePartId !== undefined &&
    input.toolCall.messagePartId !== input.part.id
  ) {
    throw new ServiceError('ToolPart/tool_calls part id mismatch.', 500);
  }

  if (
    input.toolCall.messageId !== undefined &&
    input.toolCall.messageId !== input.part.messageId
  ) {
    throw new ServiceError('ToolPart/tool_calls message id mismatch.', 500);
  }

  if (
    input.toolCall.modelToolCallId !== undefined &&
    input.toolCall.modelToolCallId !== input.part.modelToolCallId
  ) {
    throw new ServiceError(
      'ToolPart/tool_calls model tool call id mismatch.',
      500
    );
  }

  if (
    input.toolCall.sessionId !== undefined &&
    input.toolCall.sessionId !== input.part.sessionId
  ) {
    throw new ServiceError('ToolPart/tool_calls session id mismatch.', 500);
  }

  if (
    input.toolCall.toolName !== undefined &&
    input.toolCall.toolName !== input.part.toolName
  ) {
    throw new ServiceError('ToolPart/tool_calls name mismatch.', 500);
  }
}

function assertToolPartStateMatchesToolCallStatus(input: {
  part: ToolPart;
  status: ToolCallStatus;
}) {
  switch (input.part.state.status) {
    case 'pending':
      if (input.status === 'pending' || input.status === 'pending_approval') {
        return;
      }
      break;
    case 'running':
      if (input.status === 'running') {
        return;
      }
      break;
    case 'completed':
      if (input.status === 'completed') {
        return;
      }
      break;
    case 'error':
      if (input.status === 'failed' || input.status === 'rejected') {
        return;
      }
      break;
  }

  throw new ServiceError('ToolPart/tool_calls status mismatch.', 500);
}

export const toolStateService = {
  createToolPartWithToolCall(input: CreateToolPartWithToolCallInput): {
    part: ToolPart;
    toolCall: ToolCallDto;
  } {
    assertToolPartMatchesToolCall(input);
    assertToolPartStateMatchesToolCallStatus({
      part: input.part,
      status: input.toolCall.status
    });

    return toolStateRepository.create(input);
  },

  updateToolPartWithToolCall(input: UpdateToolPartWithToolCallInput): {
    part: ToolPart;
    toolCall: ToolCallDto;
  } {
    const updatedAt = input.toolCall.updatedAt ?? new Date().toISOString();
    const updatedPart: ToolPart = {
      ...input.part,
      updatedAt
    };

    assertToolPartMatchesToolCall({
      part: updatedPart,
      toolCall: input.toolCall
    });
    assertToolPartStateMatchesToolCallStatus({
      part: updatedPart,
      status: input.toolCall.status
    });

    return toolStateRepository.update({
      part: updatedPart,
      toolCall: {
        ...input.toolCall,
        updatedAt
      }
    });
  }
};
