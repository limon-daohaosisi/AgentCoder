import { plans } from '@opencode/orm';
import type { NewPlan, PlanRow } from '@opencode/orm';
import type { PlanDto } from '@opencode/shared';
import { eq, max } from 'drizzle-orm';
import { Database } from '../db/runtime.js';

function mapNullableString(value: null | string) {
  return value ?? undefined;
}

function mapPlanRow(row: PlanRow): PlanDto {
  return {
    createdAt: row.createdAt,
    id: row.id,
    sessionId: row.sessionId,
    summaryText: mapNullableString(row.summaryText)
  };
}

export const planRepository = {
  create(input: NewPlan): PlanDto {
    const row = Database.use((db) =>
      db.insert(plans).values(input).returning().get()
    );
    return mapPlanRow(row);
  },

  getById(id: string): PlanDto | null {
    const row = Database.use((db) =>
      db.select().from(plans).where(eq(plans.id, id)).get()
    );
    return row ? mapPlanRow(row) : null;
  },

  getNextVersionForSession(sessionId: string): number {
    const row = Database.use((db) =>
      db
        .select({ maxVersion: max(plans.version) })
        .from(plans)
        .where(eq(plans.sessionId, sessionId))
        .get()
    );

    return (row?.maxVersion ?? 0) + 1;
  }
};
