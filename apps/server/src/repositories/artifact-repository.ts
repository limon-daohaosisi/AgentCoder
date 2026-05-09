import { artifacts } from '@opencode/orm';
import type { ArtifactRow, NewArtifact } from '@opencode/orm';
import { and, desc, eq } from 'drizzle-orm';
import { Database } from '../db/runtime.js';
import { parseJsonValue, stringifyJsonValue } from '../lib/json.js';

export type ArtifactRecord = {
  bodyText?: string;
  createdAt: string;
  id: string;
  kind: string;
  mimeType: string;
  payload?: Record<string, unknown>;
  sessionId: string;
  taskId?: string;
  title: string;
  toolCallId?: string;
};

type CreateArtifactInput = Omit<
  NewArtifact,
  'bodyText' | 'mimeType' | 'payloadJson'
> & {
  bodyText?: null | string;
  mimeType?: null | string;
  payload?: null | Record<string, unknown>;
};

function mapNullableString(value: null | string) {
  return value ?? undefined;
}

function mapArtifactRow(row: ArtifactRow): ArtifactRecord {
  return {
    bodyText: mapNullableString(row.bodyText),
    createdAt: row.createdAt,
    id: row.id,
    kind: row.kind,
    mimeType: row.mimeType,
    payload: row.payloadJson
      ? parseJsonValue<Record<string, unknown>>(row.payloadJson, {})
      : undefined,
    sessionId: row.sessionId,
    taskId: mapNullableString(row.taskId),
    title: row.title,
    toolCallId: mapNullableString(row.toolCallId)
  };
}

export const artifactRepository = {
  create(input: CreateArtifactInput): ArtifactRecord {
    const row = Database.use((db) =>
      db
        .insert(artifacts)
        .values({
          ...input,
          bodyText: input.bodyText ?? null,
          mimeType: input.mimeType ?? 'application/json',
          payloadJson:
            input.payload === undefined || input.payload === null
              ? null
              : stringifyJsonValue(input.payload)
        })
        .returning()
        .get()
    );

    return mapArtifactRow(row);
  },

  listBySessionKind(sessionId: string, kind: string): ArtifactRecord[] {
    return Database.use((db) =>
      db
        .select()
        .from(artifacts)
        .where(
          and(eq(artifacts.sessionId, sessionId), eq(artifacts.kind, kind))
        )
        .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
        .all()
        .map(mapArtifactRow)
    );
  }
};
