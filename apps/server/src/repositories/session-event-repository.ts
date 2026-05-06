import { sessionEvents } from '@opencode/orm';
import type { NewSessionEvent, SessionEventRow } from '@opencode/orm';
import type { SessionEvent, SessionEventEnvelope } from '@opencode/shared';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { parseJsonValue, stringifyJsonValue } from '../lib/json.js';

type AppendSessionEventInput = {
  createdAt: string;
  detailText?: null | string;
  entityId?: null | string;
  entityType?: null | string;
  event: SessionEvent;
  headline?: null | string;
  level?: NewSessionEvent['level'];
  runId?: null | string;
  sessionId: string;
  taskId?: null | string;
};

function buildFallbackEvent(row: SessionEventRow): SessionEvent {
  return {
    sessionId: row.sessionId,
    type: 'session.updated',
    updatedAt: row.createdAt
  };
}

function mapSessionEventRow(row: SessionEventRow): SessionEventEnvelope {
  return {
    createdAt: row.createdAt,
    event: parseJsonValue<SessionEvent>(
      row.payloadJson,
      buildFallbackEvent(row)
    ),
    sequenceNo: row.sequenceNo
  };
}

export const sessionEventRepository = {
  append(input: AppendSessionEventInput): SessionEventEnvelope {
    return db.transaction((tx) => {
      const previous = tx
        .select({ sequenceNo: sessionEvents.sequenceNo })
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, input.sessionId))
        .orderBy(desc(sessionEvents.sequenceNo))
        .get();
      const sequenceNo = (previous?.sequenceNo ?? 0) + 1;

      const row = tx
        .insert(sessionEvents)
        .values({
          createdAt: input.createdAt,
          detailText: input.detailText ?? null,
          entityId: input.entityId ?? null,
          entityType: input.entityType ?? null,
          headline: input.headline ?? null,
          id: `${input.sessionId}:${sequenceNo}`,
          level: input.level ?? 'info',
          payloadJson: stringifyJsonValue(input.event),
          runId: input.runId ?? null,
          sequenceNo,
          sessionId: input.sessionId,
          taskId: input.taskId ?? null,
          type: input.event.type
        })
        .returning()
        .get();

      return mapSessionEventRow(row);
    });
  },

  listAfterSequence(
    sessionId: string,
    afterSequenceNo: number
  ): SessionEventEnvelope[] {
    const query = db
      .select()
      .from(sessionEvents)
      .where(
        afterSequenceNo > 0
          ? and(
              eq(sessionEvents.sessionId, sessionId),
              gt(sessionEvents.sequenceNo, afterSequenceNo)
            )
          : eq(sessionEvents.sessionId, sessionId)
      )
      .orderBy(asc(sessionEvents.sequenceNo));

    return query.all().map(mapSessionEventRow);
  }
};
