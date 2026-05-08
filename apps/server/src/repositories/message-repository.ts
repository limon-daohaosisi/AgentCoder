import { messages } from '@opencode/orm';
import type { MessageRow, NewMessage } from '@opencode/orm';
import type {
  MessageDto,
  MessagePart,
  MessageRuntimeMetadata,
  MessageStatus,
  TokenUsageDto
} from '@opencode/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Database } from '../db/runtime.js';
import { parseJsonValue, stringifyJsonValue } from '../lib/json.js';

type CreateMessageInput = Omit<
  NewMessage,
  | 'contentJson'
  | 'providerMetadataJson'
  | 'runtimeJson'
  | 'summary'
  | 'tokenUsageJson'
> & {
  content: MessagePart[];
  providerMetadata?: Record<string, unknown>;
  runtime?: MessageRuntimeMetadata;
  summary?: boolean;
  tokenUsage?: TokenUsageDto;
};

export type UpdateMessageRuntimeInput = {
  errorText?: null | string;
  finishReason?: null | string;
  id: string;
  modelResponseId?: null | string;
  providerMetadata?: null | Record<string, unknown>;
  status?: MessageStatus;
  tokenUsage?: null | TokenUsageDto;
  updatedAt: string;
};

type CancelRunningByRunInput = {
  errorText?: null | string;
  finishReason: string;
  runId: string;
  updatedAt: string;
};

function mapMessageRow(row: MessageRow): MessageDto {
  const providerMetadata = row.providerMetadataJson
    ? parseJsonValue<Record<string, unknown>>(row.providerMetadataJson, {})
    : undefined;
  const runtime = row.runtimeJson
    ? parseJsonValue<MessageRuntimeMetadata>(row.runtimeJson, {})
    : undefined;
  const tokenUsage = row.tokenUsageJson
    ? parseJsonValue<TokenUsageDto>(row.tokenUsageJson, {
        input: 0,
        output: 0
      })
    : undefined;

  return {
    agentName: row.agentName ?? undefined,
    compactedByMessageId: row.compactedByMessageId ?? undefined,
    content: parseJsonValue<MessagePart[]>(row.contentJson, []),
    createdAt: row.createdAt,
    errorText: row.errorText ?? undefined,
    finishReason: row.finishReason ?? undefined,
    id: row.id,
    kind: 'message',
    model:
      row.modelProviderId && row.modelId
        ? {
            modelId: row.modelId,
            providerId: row.modelProviderId
          }
        : undefined,
    modelResponseId: row.modelResponseId ?? undefined,
    parentMessageId: row.parentMessageId ?? undefined,
    providerMetadata,
    role: row.role as MessageDto['role'],
    runId: row.runId ?? undefined,
    runtime,
    sessionId: row.sessionId,
    status: row.status as MessageStatus,
    summary: row.summary === 1 ? true : undefined,
    tokenUsage,
    updatedAt: row.updatedAt
  };
}

export const messageRepository = {
  cancelRunningByRun(input: CancelRunningByRunInput): MessageDto[] {
    return Database.use((db) =>
      db
        .update(messages)
        .set({
          errorText: input.errorText,
          finishReason: input.finishReason,
          status: 'cancelled',
          updatedAt: input.updatedAt
        })
        .where(
          and(
            eq(messages.runId, input.runId),
            eq(messages.role, 'assistant'),
            eq(messages.status, 'running')
          )
        )
        .returning()
        .all()
        .map(mapMessageRow)
    );
  },

  create(input: CreateMessageInput): MessageDto {
    const row = Database.use((db) =>
      db
        .insert(messages)
        .values({
          ...input,
          contentJson: stringifyJsonValue(input.content),
          providerMetadataJson: input.providerMetadata
            ? stringifyJsonValue(input.providerMetadata)
            : null,
          runtimeJson: input.runtime ? stringifyJsonValue(input.runtime) : null,
          summary: input.summary ? 1 : 0,
          tokenUsageJson: input.tokenUsage
            ? stringifyJsonValue(input.tokenUsage)
            : null
        })
        .returning()
        .get()
    );

    return mapMessageRow(row);
  },

  getById(id: string): MessageDto | null {
    const row = Database.use((db) =>
      db.select().from(messages).where(eq(messages.id, id)).get()
    );
    return row ? mapMessageRow(row) : null;
  },

  listBySession(sessionId: string): MessageDto[] {
    return Database.use((db) =>
      db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        // Message ids are random UUIDs, so keep SQLite insertion order when
        // multiple messages share the same timestamp.
        .orderBy(asc(messages.createdAt), asc(sql<number>`rowid`))
        .all()
        .map(mapMessageRow)
    );
  },

  listRunningByRun(runId: string): MessageDto[] {
    return Database.use((db) =>
      db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.runId, runId),
            eq(messages.role, 'assistant'),
            eq(messages.status, 'running')
          )
        )
        .orderBy(asc(messages.createdAt), asc(sql<number>`rowid`))
        .all()
        .map(mapMessageRow)
    );
  },

  updateContent(id: string, content: MessagePart[]): MessageDto | null {
    const row = Database.use((db) =>
      db
        .update(messages)
        .set({
          contentJson: stringifyJsonValue(content)
        })
        .where(eq(messages.id, id))
        .returning()
        .get()
    );

    return row ? mapMessageRow(row) : null;
  },

  updateRuntime(input: UpdateMessageRuntimeInput): MessageDto | null {
    const row = Database.use((db) =>
      db
        .update(messages)
        .set({
          errorText: input.errorText,
          finishReason: input.finishReason,
          modelResponseId: input.modelResponseId,
          providerMetadataJson:
            input.providerMetadata === undefined
              ? undefined
              : input.providerMetadata === null
                ? null
                : stringifyJsonValue(input.providerMetadata),
          status: input.status,
          tokenUsageJson:
            input.tokenUsage === undefined
              ? undefined
              : input.tokenUsage === null
                ? null
                : stringifyJsonValue(input.tokenUsage),
          updatedAt: input.updatedAt
        })
        .where(eq(messages.id, input.id))
        .returning()
        .get()
    );

    return row ? mapMessageRow(row) : null;
  }
};
