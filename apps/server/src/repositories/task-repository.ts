import { tasks } from '@opencode/orm';
import type { NewTask, TaskRow } from '@opencode/orm';
import type { TaskDto, TaskStatus } from '@opencode/shared';
import { and, asc, eq, max } from 'drizzle-orm';
import { Database } from '../db/runtime.js';
import { parseJsonValue, stringifyJsonValue } from '../lib/json.js';

type CreateTaskInput = Omit<NewTask, 'acceptanceCriteriaJson'> & {
  acceptanceCriteria: string[];
};

type UpdateTaskInput = {
  acceptanceCriteria?: string[];
  completedAt?: null | string;
  description?: null | string;
  id: string;
  lastErrorText?: null | string;
  position?: number;
  startedAt?: null | string;
  status?: TaskStatus;
  summaryText?: null | string;
  title?: string;
  updatedAt: string;
};

function mapNullableString(value: null | string) {
  return value ?? undefined;
}

function mapTaskRow(row: TaskRow): TaskDto {
  return {
    acceptanceCriteria: parseJsonValue<string[]>(
      row.acceptanceCriteriaJson,
      []
    ),
    completedAt: mapNullableString(row.completedAt),
    description: mapNullableString(row.description),
    id: row.id,
    lastErrorText: mapNullableString(row.lastErrorText),
    planId: row.planId,
    position: row.position,
    sessionId: row.sessionId,
    startedAt: mapNullableString(row.startedAt),
    status: row.status as TaskStatus,
    summaryText: mapNullableString(row.summaryText),
    title: row.title,
    updatedAt: row.updatedAt
  };
}

export const taskRepository = {
  create(input: CreateTaskInput): TaskDto {
    const row = Database.use((db) =>
      db
        .insert(tasks)
        .values({
          ...input,
          acceptanceCriteriaJson: stringifyJsonValue(input.acceptanceCriteria)
        })
        .returning()
        .get()
    );

    return mapTaskRow(row);
  },

  getById(id: string): TaskDto | null {
    const row = Database.use((db) =>
      db.select().from(tasks).where(eq(tasks.id, id)).get()
    );
    return row ? mapTaskRow(row) : null;
  },

  getByIdForSession(sessionId: string, taskId: string): TaskDto | null {
    const row = Database.use((db) =>
      db
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.sessionId, sessionId)))
        .get()
    );

    return row ? mapTaskRow(row) : null;
  },

  getNextPositionForPlan(planId: string): number {
    const row = Database.use((db) =>
      db
        .select({ maxPosition: max(tasks.position) })
        .from(tasks)
        .where(eq(tasks.planId, planId))
        .get()
    );

    return (row?.maxPosition ?? 0) + 1;
  },

  listByPlan(planId: string): TaskDto[] {
    return Database.use((db) =>
      db
        .select()
        .from(tasks)
        .where(eq(tasks.planId, planId))
        .orderBy(asc(tasks.position), asc(tasks.updatedAt), asc(tasks.id))
        .all()
        .map(mapTaskRow)
    );
  },

  update(input: UpdateTaskInput): TaskDto | null {
    const row = Database.use((db) =>
      db
        .update(tasks)
        .set({
          acceptanceCriteriaJson:
            input.acceptanceCriteria === undefined
              ? undefined
              : stringifyJsonValue(input.acceptanceCriteria),
          completedAt: input.completedAt,
          description: input.description,
          lastErrorText: input.lastErrorText,
          position: input.position,
          startedAt: input.startedAt,
          status: input.status,
          summaryText: input.summaryText,
          title: input.title,
          updatedAt: input.updatedAt
        })
        .where(eq(tasks.id, input.id))
        .returning()
        .get()
    );

    return row ? mapTaskRow(row) : null;
  }
};
