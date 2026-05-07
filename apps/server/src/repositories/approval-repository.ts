import { approvals } from '@opencode/orm';
import type { ApprovalRow, NewApproval } from '@opencode/orm';
import type { ApprovalDto, ApprovalStatus } from '@opencode/shared';
import { and, asc, eq } from 'drizzle-orm';
import { Database } from '../db/runtime.js';
import { parseJsonValue, stringifyJsonValue } from '../lib/json.js';

type CreateApprovalInput = Omit<NewApproval, 'payloadJson'> & {
  payload: Record<string, unknown>;
};

type UpdateApprovalDecisionInput = {
  decidedAt: string;
  decisionReasonText?: null | string;
  id: string;
  status: ApprovalStatus;
};

type RejectPendingByRunInput = {
  decidedAt: string;
  decisionReasonText: string;
  runId: string;
};

function mapNullableString(value: null | string) {
  return value ?? undefined;
}

function mapApprovalRow(row: ApprovalRow): ApprovalDto {
  return {
    createdAt: row.createdAt,
    decidedAt: mapNullableString(row.decidedAt),
    decidedBy: mapNullableString(row.decidedBy),
    decisionReasonText: mapNullableString(row.decisionReasonText),
    decisionScope: row.decisionScope as ApprovalDto['decisionScope'],
    id: row.id,
    kind: row.kind as ApprovalDto['kind'],
    payload: parseJsonValue<Record<string, unknown>>(row.payloadJson, {}),
    runId: mapNullableString(row.runId),
    sessionId: row.sessionId,
    status: row.status as ApprovalStatus,
    suggestedRuleJson: mapNullableString(row.suggestedRuleJson),
    taskId: mapNullableString(row.taskId),
    toolCallId: row.toolCallId
  };
}

export const approvalRepository = {
  create(input: CreateApprovalInput): ApprovalDto {
    const row = Database.use((db) =>
      db
        .insert(approvals)
        .values({
          ...input,
          payloadJson: stringifyJsonValue(input.payload)
        })
        .returning()
        .get()
    );

    return mapApprovalRow(row);
  },

  getById(id: string): ApprovalDto | null {
    const row = Database.use((db) =>
      db.select().from(approvals).where(eq(approvals.id, id)).get()
    );
    return row ? mapApprovalRow(row) : null;
  },

  listPendingBySession(sessionId: string): ApprovalDto[] {
    return Database.use((db) =>
      db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.sessionId, sessionId),
            eq(approvals.status, 'pending')
          )
        )
        .orderBy(asc(approvals.createdAt), asc(approvals.id))
        .all()
        .map(mapApprovalRow)
    );
  },

  listPendingByRun(runId: string): ApprovalDto[] {
    return Database.use((db) =>
      db
        .select()
        .from(approvals)
        .where(and(eq(approvals.runId, runId), eq(approvals.status, 'pending')))
        .orderBy(asc(approvals.createdAt), asc(approvals.id))
        .all()
        .map(mapApprovalRow)
    );
  },

  rejectPendingByRun(input: RejectPendingByRunInput): ApprovalDto[] {
    return Database.use((db) =>
      db
        .update(approvals)
        .set({
          decidedAt: input.decidedAt,
          decisionReasonText: input.decisionReasonText,
          status: 'rejected'
        })
        .where(
          and(eq(approvals.runId, input.runId), eq(approvals.status, 'pending'))
        )
        .returning()
        .all()
        .map(mapApprovalRow)
    );
  },

  updateDecision(input: UpdateApprovalDecisionInput): ApprovalDto | null {
    const row = Database.use((db) =>
      db
        .update(approvals)
        .set({
          decidedAt: input.decidedAt,
          decisionReasonText: input.decisionReasonText,
          status: input.status
        })
        .where(and(eq(approvals.id, input.id), eq(approvals.status, 'pending')))
        .returning()
        .get()
    );

    return row ? mapApprovalRow(row) : null;
  }
};
