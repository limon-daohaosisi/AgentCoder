import { messageParts, toolCalls } from '@opencode/orm';
import type { MessagePartRow, ToolCallRow } from '@opencode/orm';
import type {
  BatchChildRef,
  MessagePart,
  ToolCallDto,
  ToolCallStatus
} from '@opencode/shared';
import { eq } from 'drizzle-orm';
import { Database } from '../db/runtime.js';
import { ServiceError } from '../lib/service-error.js';
import { parseJsonValue, stringifyJsonValue } from '../lib/json.js';

type ToolPart = Extract<MessagePart, { type: 'tool' }>;

type CreateToolStateInput = {
  part: ToolPart;
  toolCall: {
    batch?: BatchChildRef;
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

type UpdateToolStateInput = {
  part: ToolPart;
  toolCall: {
    completedAt?: null | string;
    errorText?: null | string;
    id: string;
    result?: null | Record<string, unknown>;
    startedAt?: null | string;
    status: ToolCallStatus;
    updatedAt: string;
  };
};

function mapNullableRecord(value: null | string) {
  return value ? parseJsonValue<Record<string, unknown>>(value, {}) : undefined;
}

function mapNullableString(value: null | string) {
  return value ?? undefined;
}

function mapMessagePartRow(row: MessagePartRow): MessagePart {
  return parseJsonValue<MessagePart>(row.dataJson, {
    createdAt: row.createdAt,
    id: row.id,
    messageId: row.messageId,
    order: row.orderIndex,
    sessionId: row.sessionId,
    text: '',
    type: 'text',
    updatedAt: row.updatedAt
  });
}

function mapToolCallRow(row: ToolCallRow): ToolCallDto {
  return {
    batch: mapNullableRecord(row.batchJson) as BatchChildRef | undefined,
    createdAt: row.createdAt,
    errorText: mapNullableString(row.errorText),
    id: row.id,
    input: parseJsonValue<Record<string, unknown>>(row.inputJson, {}),
    messageId: mapNullableString(row.messageId),
    messagePartId: mapNullableString(row.messagePartId),
    modelToolCallId: mapNullableString(row.modelToolCallId),
    providerMetadata: mapNullableRecord(row.providerMetadataJson),
    requiresApproval: row.requiresApproval === 1,
    result: mapNullableRecord(row.resultJson),
    runId: mapNullableString(row.runId),
    sessionId: row.sessionId,
    status: row.status as ToolCallStatus,
    taskId: mapNullableString(row.taskId),
    toolName: row.toolName as ToolCallDto['toolName'],
    updatedAt: row.updatedAt
  };
}

function assertStoredToolStateMatches(input: {
  part: ToolPart;
  toolCall: ToolCallRow;
}) {
  if (
    input.part.toolCallId !== input.toolCall.id ||
    input.part.id !== input.toolCall.messagePartId ||
    input.part.messageId !== input.toolCall.messageId ||
    input.part.modelToolCallId !== input.toolCall.modelToolCallId ||
    input.part.sessionId !== input.toolCall.sessionId ||
    input.part.toolName !== input.toolCall.toolName
  ) {
    throw new ServiceError('Stored ToolPart/tool_calls state mismatch.', 500);
  }
}

export const toolStateRepository = {
  create(input: CreateToolStateInput): {
    part: ToolPart;
    toolCall: ToolCallDto;
  } {
    return Database.transaction(() => {
      return Database.use((db) => {
        const partRow = db
          .insert(messageParts)
          .values({
            createdAt: input.part.createdAt,
            dataJson: stringifyJsonValue(input.part),
            id: input.part.id,
            messageId: input.part.messageId,
            orderIndex: input.part.order,
            runId: input.toolCall.runId ?? null,
            sessionId: input.part.sessionId,
            type: input.part.type,
            updatedAt: input.part.updatedAt
          })
          .returning()
          .get();
        const toolCallRow = db
          .insert(toolCalls)
          .values({
            batchJson: input.toolCall.batch
              ? stringifyJsonValue(input.toolCall.batch)
              : null,
            completedAt: null,
            createdAt: input.toolCall.createdAt,
            errorText: null,
            id: input.toolCall.id,
            inputJson: stringifyJsonValue(input.toolCall.input),
            messageId: input.toolCall.messageId,
            messagePartId: input.toolCall.messagePartId,
            modelToolCallId: input.toolCall.modelToolCallId,
            providerMetadataJson: input.toolCall.providerMetadata
              ? stringifyJsonValue(input.toolCall.providerMetadata)
              : null,
            requiresApproval: input.toolCall.requiresApproval ? 1 : 0,
            resultJson: null,
            runId: input.toolCall.runId ?? null,
            sessionId: input.toolCall.sessionId,
            startedAt: input.toolCall.startedAt,
            status: input.toolCall.status,
            taskId: input.toolCall.taskId,
            toolName: input.toolCall.toolName,
            updatedAt: input.toolCall.updatedAt
          })
          .returning()
          .get();

        const part = mapMessagePartRow(partRow);

        if (part.type !== 'tool') {
          throw new ServiceError('Created part is not a ToolPart.', 500);
        }

        return {
          part,
          toolCall: mapToolCallRow(toolCallRow)
        };
      });
    });
  },

  update(input: UpdateToolStateInput): {
    part: ToolPart;
    toolCall: ToolCallDto;
  } {
    return Database.transaction(() => {
      return Database.use((db) => {
        const existingPartRow = db
          .select()
          .from(messageParts)
          .where(eq(messageParts.id, input.part.id))
          .get();
        const existingToolCallRow = db
          .select()
          .from(toolCalls)
          .where(eq(toolCalls.id, input.toolCall.id))
          .get();

        if (!existingPartRow || !existingToolCallRow) {
          throw new ServiceError('Tool state row not found.', 404);
        }

        const existingPart = mapMessagePartRow(existingPartRow);

        if (existingPart.type !== 'tool') {
          throw new ServiceError('Existing part is not a ToolPart.', 500);
        }

        assertStoredToolStateMatches({
          part: existingPart,
          toolCall: existingToolCallRow
        });
        assertStoredToolStateMatches({
          part: input.part,
          toolCall: existingToolCallRow
        });

        if (
          existingToolCallRow.status !== 'running' &&
          input.toolCall.status === 'completed'
        ) {
          throw new ServiceError(
            `Tool call ${input.toolCall.id} is no longer running.`,
            409
          );
        }

        const partRow = db
          .update(messageParts)
          .set({
            dataJson: stringifyJsonValue(input.part),
            updatedAt: input.toolCall.updatedAt
          })
          .where(eq(messageParts.id, input.part.id))
          .returning()
          .get();

        const toolCallRow = db
          .update(toolCalls)
          .set({
            completedAt: input.toolCall.completedAt,
            errorText: input.toolCall.errorText,
            resultJson:
              input.toolCall.result === undefined
                ? undefined
                : input.toolCall.result === null
                  ? null
                  : stringifyJsonValue(input.toolCall.result),
            startedAt: input.toolCall.startedAt,
            status: input.toolCall.status,
            updatedAt: input.toolCall.updatedAt
          })
          .where(eq(toolCalls.id, input.toolCall.id))
          .returning()
          .get();

        if (!partRow || !toolCallRow) {
          throw new ServiceError(
            'Failed to update tool state transaction.',
            500
          );
        }

        const part = mapMessagePartRow(partRow);

        if (part.type !== 'tool') {
          throw new ServiceError('Updated part is not a ToolPart.', 500);
        }

        return {
          part,
          toolCall: mapToolCallRow(toolCallRow)
        };
      });
    });
  }
};
