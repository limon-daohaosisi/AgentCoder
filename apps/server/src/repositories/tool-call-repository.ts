import { toolCalls } from '@opencode/orm';
import type { NewToolCall, ToolCallRow } from '@opencode/orm';
import type { ToolCallDto, ToolCallStatus } from '@opencode/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Database } from '../db/runtime.js';
import { parseJsonValue, stringifyJsonValue } from '../lib/json.js';

type CreateToolCallInput = Omit<
  NewToolCall,
  'inputJson' | 'providerMetadataJson' | 'requiresApproval'
> & {
  input: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
  requiresApproval: boolean;
};

type UpdateToolCallInput = {
  completedAt?: null | string;
  errorText?: null | string;
  id: string;
  result?: null | Record<string, unknown>;
  startedAt?: null | string;
  status: ToolCallStatus;
  updatedAt: string;
};

type FailOpenByRunInput = {
  completedAt: string;
  errorText: string;
  result: Record<string, unknown>;
  runId: string;
  updatedAt: string;
};

function mapNullableRecord(value: null | string) {
  return value ? parseJsonValue<Record<string, unknown>>(value, {}) : undefined;
}

function mapNullableString(value: null | string) {
  return value ?? undefined;
}

function mapToolCallRow(row: ToolCallRow): ToolCallDto {
  return {
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

export const toolCallRepository = {
  create(input: CreateToolCallInput): ToolCallDto {
    const row = Database.use((db) =>
      db
        .insert(toolCalls)
        .values({
          ...input,
          inputJson: stringifyJsonValue(input.input),
          providerMetadataJson: input.providerMetadata
            ? stringifyJsonValue(input.providerMetadata)
            : null,
          requiresApproval: input.requiresApproval ? 1 : 0
        })
        .returning()
        .get()
    );

    return mapToolCallRow(row);
  },

  getById(id: string): ToolCallDto | null {
    const row = Database.use((db) =>
      db.select().from(toolCalls).where(eq(toolCalls.id, id)).get()
    );
    return row ? mapToolCallRow(row) : null;
  },

  failOpenByRun(input: FailOpenByRunInput): ToolCallDto[] {
    return Database.use((db) =>
      db
        .update(toolCalls)
        .set({
          completedAt: input.completedAt,
          errorText: input.errorText,
          resultJson: stringifyJsonValue(input.result),
          status: 'failed',
          updatedAt: input.updatedAt
        })
        .where(
          and(
            eq(toolCalls.runId, input.runId),
            inArray(toolCalls.status, [
              'pending',
              'pending_approval',
              'approved',
              'running'
            ])
          )
        )
        .returning()
        .all()
        .map(mapToolCallRow)
    );
  },

  listOpenByRun(runId: string): ToolCallDto[] {
    return Database.use((db) =>
      db
        .select()
        .from(toolCalls)
        .where(
          and(
            eq(toolCalls.runId, runId),
            inArray(toolCalls.status, [
              'pending',
              'pending_approval',
              'approved',
              'running'
            ])
          )
        )
        .orderBy(asc(toolCalls.createdAt), asc(toolCalls.id))
        .all()
        .map(mapToolCallRow)
    );
  },

  update(input: UpdateToolCallInput): ToolCallDto | null {
    const row = Database.use((db) =>
      db
        .update(toolCalls)
        .set({
          completedAt: input.completedAt,
          errorText: input.errorText,
          resultJson:
            input.result === undefined
              ? undefined
              : input.result === null
                ? null
                : stringifyJsonValue(input.result),
          startedAt: input.startedAt,
          status: input.status,
          updatedAt: input.updatedAt
        })
        .where(eq(toolCalls.id, input.id))
        .returning()
        .get()
    );

    return row ? mapToolCallRow(row) : null;
  }
};
