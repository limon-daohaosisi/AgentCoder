import { messageParts } from '@opencode/orm';
import type { MessagePartRow, NewMessagePart } from '@opencode/orm';
import type { MessagePart } from '@opencode/shared';
import { and, asc, eq } from 'drizzle-orm';
import { Database } from '../db/runtime.js';
import { parseJsonValue, stringifyJsonValue } from '../lib/json.js';

type CreateMessagePartInput = Omit<
  NewMessagePart,
  'dataJson' | 'orderIndex'
> & {
  data: MessagePart;
  order: number;
};

type UpdateMessagePartInput = {
  data: MessagePart;
  id: string;
  updatedAt: string;
};

type InterruptOpenToolPartsByRunInput = {
  completedAt: string;
  errorText: string;
  payload: Record<string, unknown>;
  runId: string;
};

function mapMessagePartRow(row: MessagePartRow): MessagePart {
  return parseJsonValue<MessagePart>(row.dataJson, {
    createdAt: row.createdAt,
    id: row.id,
    messageId: row.messageId,
    order: row.orderIndex,
    sessionId: row.sessionId,
    text: '',
    type: 'text',
    updatedAt: row.updatedAt
  });
}

export const messagePartRepository = {
  create(input: CreateMessagePartInput): MessagePart {
    const row = Database.use((db) =>
      db
        .insert(messageParts)
        .values({
          ...input,
          dataJson: stringifyJsonValue(input.data),
          orderIndex: input.order
        })
        .returning()
        .get()
    );

    return mapMessagePartRow(row);
  },

  getById(id: string): MessagePart | null {
    const row = Database.use((db) =>
      db.select().from(messageParts).where(eq(messageParts.id, id)).get()
    );
    return row ? mapMessagePartRow(row) : null;
  },

  listByMessage(messageId: string): MessagePart[] {
    return Database.use((db) =>
      db
        .select()
        .from(messageParts)
        .where(eq(messageParts.messageId, messageId))
        .orderBy(asc(messageParts.orderIndex), asc(messageParts.id))
        .all()
        .map(mapMessagePartRow)
    );
  },

  listBySession(sessionId: string): MessagePart[] {
    return Database.use((db) =>
      db
        .select()
        .from(messageParts)
        .where(eq(messageParts.sessionId, sessionId))
        .orderBy(asc(messageParts.createdAt), asc(messageParts.id))
        .all()
        .map(mapMessagePartRow)
    );
  },

  listOpenToolPartsByRun(
    runId: string
  ): Extract<MessagePart, { type: 'tool' }>[] {
    return Database.use((db) =>
      db
        .select()
        .from(messageParts)
        .where(
          and(eq(messageParts.runId, runId), eq(messageParts.type, 'tool'))
        )
        .orderBy(asc(messageParts.createdAt), asc(messageParts.id))
        .all()
        .map(mapMessagePartRow)
        .filter(
          (part): part is Extract<MessagePart, { type: 'tool' }> =>
            part.type === 'tool' &&
            (part.state.status === 'pending' || part.state.status === 'running')
        )
    );
  },

  interruptOpenToolPartsByRun(
    input: InterruptOpenToolPartsByRunInput
  ): Extract<MessagePart, { type: 'tool' }>[] {
    const openParts = this.listOpenToolPartsByRun(input.runId);
    const interruptedParts: Extract<MessagePart, { type: 'tool' }>[] = [];

    for (const part of openParts) {
      const interruptedPart: Extract<MessagePart, { type: 'tool' }> = {
        ...part,
        state: {
          completedAt: input.completedAt,
          errorText: input.errorText,
          input: part.state.input,
          payload: input.payload,
          reason: 'interrupted',
          startedAt:
            part.state.status === 'running' ? part.state.startedAt : undefined,
          status: 'error'
        },
        updatedAt: input.completedAt
      };
      const updatedPart = this.update({
        data: interruptedPart,
        id: interruptedPart.id,
        updatedAt: input.completedAt
      });

      if (updatedPart?.type === 'tool') {
        interruptedParts.push(updatedPart);
      }
    }

    return interruptedParts;
  },

  listBySessionMessage(sessionId: string, messageId: string): MessagePart[] {
    return Database.use((db) =>
      db
        .select()
        .from(messageParts)
        .where(
          and(
            eq(messageParts.sessionId, sessionId),
            eq(messageParts.messageId, messageId)
          )
        )
        .orderBy(asc(messageParts.orderIndex), asc(messageParts.id))
        .all()
        .map(mapMessagePartRow)
    );
  },

  update(input: UpdateMessagePartInput): MessagePart | null {
    const row = Database.use((db) =>
      db
        .update(messageParts)
        .set({
          dataJson: stringifyJsonValue(input.data),
          updatedAt: input.updatedAt
        })
        .where(eq(messageParts.id, input.id))
        .returning()
        .get()
    );

    return row ? mapMessagePartRow(row) : null;
  }
};
