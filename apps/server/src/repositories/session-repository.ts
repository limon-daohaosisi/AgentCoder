import { sessions } from '@opencode/orm';
import type { NewSession, SessionRow } from '@opencode/orm';
import type { SessionDto, SessionStatus, SessionVariant } from '@opencode/shared';
import { desc, eq, inArray } from 'drizzle-orm';
import { Database } from '../db/runtime.js';

type UpdateResumeStateInput = {
  currentPlanId?: null | string;
  currentTaskId?: null | string;
  id: string;
  lastCheckpointJson?: null | string;
  lastErrorText?: null | string;
  status?: SessionStatus;
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
    lastCheckpointJson: mapNullable(row.lastCheckpointJson),
    lastErrorText: mapNullable(row.lastErrorText),
    status: row.status as SessionStatus,
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
        .where(eq(sessions.workspaceId, workspaceId))
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
  }
};
