import { agentRuns } from '@opencode/orm';
import type { AgentRunRow, NewAgentRun } from '@opencode/orm';
import type { AgentRunDto, AgentRunStatus } from '@opencode/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';

const openRunStatuses: AgentRunStatus[] = ['running', 'waiting_approval'];

type MarkRunInput = {
  cancelledAt?: null | string;
  endedAt?: null | string;
  errorText?: null | string;
  id: string;
  lastCheckpointJson?: null | string;
  status: AgentRunStatus;
  updatedAt: string;
};

function mapNullable(value: null | string) {
  return value ?? undefined;
}

function mapAgentRunRow(row: AgentRunRow): AgentRunDto {
  return {
    cancelledAt: mapNullable(row.cancelledAt),
    createdAt: row.createdAt,
    endedAt: mapNullable(row.endedAt),
    errorText: mapNullable(row.errorText),
    id: row.id,
    lastCheckpointJson: mapNullable(row.lastCheckpointJson),
    sessionId: row.sessionId,
    startedAt: row.startedAt,
    status: row.status as AgentRunStatus,
    triggerMessageId: mapNullable(row.triggerMessageId),
    updatedAt: row.updatedAt
  };
}

function updateOpenRun(input: MarkRunInput): AgentRunDto | null {
  const row = db
    .update(agentRuns)
    .set({
      cancelledAt: input.cancelledAt,
      endedAt: input.endedAt,
      errorText: input.errorText,
      lastCheckpointJson: input.lastCheckpointJson,
      status: input.status,
      updatedAt: input.updatedAt
    })
    .where(
      and(
        eq(agentRuns.id, input.id),
        inArray(agentRuns.status, openRunStatuses)
      )
    )
    .returning()
    .get();

  return row ? mapAgentRunRow(row) : null;
}

export const agentRunRepository = {
  create(input: NewAgentRun): AgentRunDto {
    const row = db.insert(agentRuns).values(input).returning().get();
    return mapAgentRunRow(row);
  },

  getActiveBySession(sessionId: string): AgentRunDto | null {
    const row = db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, sessionId),
          inArray(agentRuns.status, openRunStatuses)
        )
      )
      .orderBy(desc(agentRuns.createdAt))
      .get();

    return row ? mapAgentRunRow(row) : null;
  },

  getById(id: string): AgentRunDto | null {
    const row = db.select().from(agentRuns).where(eq(agentRuns.id, id)).get();
    return row ? mapAgentRunRow(row) : null;
  },

  listBySession(sessionId: string): AgentRunDto[] {
    return db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.sessionId, sessionId))
      .orderBy(desc(agentRuns.createdAt))
      .all()
      .map(mapAgentRunRow);
  },

  markBlocked(input: {
    errorText: string;
    id: string;
    updatedAt: string;
  }): AgentRunDto | null {
    return updateOpenRun({
      endedAt: input.updatedAt,
      errorText: input.errorText,
      id: input.id,
      lastCheckpointJson: null,
      status: 'blocked',
      updatedAt: input.updatedAt
    });
  },

  markCancelled(input: {
    errorText?: null | string;
    id: string;
    updatedAt: string;
  }): AgentRunDto | null {
    return updateOpenRun({
      cancelledAt: input.updatedAt,
      endedAt: input.updatedAt,
      errorText: input.errorText ?? null,
      id: input.id,
      lastCheckpointJson: null,
      status: 'cancelled',
      updatedAt: input.updatedAt
    });
  },

  markCompleted(input: { id: string; updatedAt: string }): AgentRunDto | null {
    return updateOpenRun({
      endedAt: input.updatedAt,
      errorText: null,
      id: input.id,
      lastCheckpointJson: null,
      status: 'completed',
      updatedAt: input.updatedAt
    });
  },

  markFailed(input: {
    errorText: string;
    id: string;
    updatedAt: string;
  }): AgentRunDto | null {
    return updateOpenRun({
      endedAt: input.updatedAt,
      errorText: input.errorText,
      id: input.id,
      lastCheckpointJson: null,
      status: 'failed',
      updatedAt: input.updatedAt
    });
  },

  markRunning(input: { id: string; updatedAt: string }): AgentRunDto | null {
    const row = db
      .update(agentRuns)
      .set({
        lastCheckpointJson: null,
        status: 'running',
        updatedAt: input.updatedAt
      })
      .where(
        and(
          eq(agentRuns.id, input.id),
          eq(agentRuns.status, 'waiting_approval')
        )
      )
      .returning()
      .get();

    return row ? mapAgentRunRow(row) : null;
  },

  markWaitingApproval(input: {
    id: string;
    lastCheckpointJson: string;
    updatedAt: string;
  }): AgentRunDto | null {
    return updateOpenRun({
      id: input.id,
      lastCheckpointJson: input.lastCheckpointJson,
      status: 'waiting_approval',
      updatedAt: input.updatedAt
    });
  },

  setTriggerMessage(input: {
    id: string;
    triggerMessageId: string;
    updatedAt: string;
  }): AgentRunDto | null {
    const row = db
      .update(agentRuns)
      .set({
        triggerMessageId: input.triggerMessageId,
        updatedAt: input.updatedAt
      })
      .where(eq(agentRuns.id, input.id))
      .returning()
      .get();

    return row ? mapAgentRunRow(row) : null;
  }
};
