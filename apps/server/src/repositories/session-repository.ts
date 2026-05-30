import { sessions } from '@opencode/orm';
import type { NewSession, SessionRow } from '@opencode/orm';
import type {
  SessionRevertDto,
  SessionDto,
  SessionKind,
  SessionStatus,
  SessionVariant,
  SubagentType
} from '@opencode/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { Database } from '../db/runtime.js';
import { parseJsonValue, stringifyJsonValue } from '../lib/json.js';

type UpdateResumeStateInput = {
  currentPlanId?: null | string;
  currentTaskId?: null | string;
  id: string;
  lastCheckpointJson?: null | string;
  lastErrorText?: null | string;
  status?: SessionStatus;
  updatedAt: string;
};

type UpdateRevertStateInput = {
  id: string;
  revertJson: null | string;
  updatedAt: string;
};

function mapNullable(value: null | string): string | undefined {
  return value ?? undefined;
}

function mapSessionRow(row: SessionRow): SessionDto {
  return {
    archivedAt: mapNullable(row.archivedAt),
    createdAt: row.createdAt,
    currentPlanId: mapNullable(row.currentPlanId),
    currentTaskId: mapNullable(row.currentTaskId),
    defaultVariant: row.defaultVariant as SessionVariant,
    goalText: row.goalText,
    id: row.id,
    kind: row.kind as SessionKind,
    lastCheckpointJson: mapNullable(row.lastCheckpointJson),
    lastErrorText: mapNullable(row.lastErrorText),
    parentSessionId: mapNullable(row.parentSessionId),
    parentToolCallId: mapNullable(row.parentToolCallId),
    revert: row.revertJson
      ? parseJsonValue<SessionRevertDto>(row.revertJson, {} as SessionRevertDto)
      : undefined,
    status: row.status as SessionStatus,
    subagentType: row.subagentType
      ? (row.subagentType as SubagentType)
      : undefined,
    title: row.title,
    updatedAt: row.updatedAt,
    workspaceId: row.workspaceId
  };
}

export const sessionRepository = {
  create(input: NewSession): SessionDto {
    const row = Database.use((db) =>
      db.insert(sessions).values(input).returning().get()
    );
    return mapSessionRow(row);
  },

  getById(id: string): SessionDto | null {
    const row = Database.use((db) =>
      db.select().from(sessions).where(eq(sessions.id, id)).get()
    );
    return row ? mapSessionRow(row) : null;
  },

  listByWorkspace(workspaceId: string): SessionDto[] {
    return Database.use((db) =>
      db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.workspaceId, workspaceId),
            eq(sessions.kind, 'primary')
          )
        )
        .orderBy(desc(sessions.updatedAt))
        .all()
        .map(mapSessionRow)
    );
  },

  listByStatuses(statuses: SessionStatus[]): SessionDto[] {
    if (statuses.length === 0) {
      return [];
    }

    return Database.use((db) =>
      db
        .select()
        .from(sessions)
        .where(inArray(sessions.status, statuses))
        .orderBy(desc(sessions.updatedAt))
        .all()
        .map(mapSessionRow)
    );
  },

  updateResumeState(input: UpdateResumeStateInput): SessionDto | null {
    const changes: Partial<NewSession> = {
      updatedAt: input.updatedAt
    };

    if (input.status !== undefined) {
      changes.status = input.status;
    }

    if (input.currentPlanId !== undefined) {
      changes.currentPlanId = input.currentPlanId;
    }

    if (input.currentTaskId !== undefined) {
      changes.currentTaskId = input.currentTaskId;
    }

    if (input.lastCheckpointJson !== undefined) {
      changes.lastCheckpointJson = input.lastCheckpointJson;
    }

    if (input.lastErrorText !== undefined) {
      changes.lastErrorText = input.lastErrorText;
    }

    const row = Database.use((db) =>
      db
        .update(sessions)
        .set(changes)
        .where(eq(sessions.id, input.id))
        .returning()
        .get()
    );

    return row ? mapSessionRow(row) : null;
  },

  updateRevertState(input: UpdateRevertStateInput): SessionDto | null {
    const row = Database.use((db) =>
      db
        .update(sessions)
        .set({
          revertJson: input.revertJson,
          updatedAt: input.updatedAt
        })
        .where(eq(sessions.id, input.id))
        .returning()
        .get()
    );

    return row ? mapSessionRow(row) : null;
  },

  setRevert(input: {
    id: string;
    revert: SessionRevertDto | null;
    updatedAt: string;
  }) {
    return this.updateRevertState({
      id: input.id,
      revertJson:
        input.revert === null ? null : stringifyJsonValue(input.revert),
      updatedAt: input.updatedAt
    });
  },

  clearRevert(input: { id: string; updatedAt: string }) {
    return this.updateRevertState({
      id: input.id,
      revertJson: null,
      updatedAt: input.updatedAt
    });
  }
};
