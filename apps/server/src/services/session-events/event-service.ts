import type {
  SessionCheckpoint,
  SessionEvent,
  SessionEventEnvelope
} from '@opencode/shared';
import { Database } from '../../db/runtime.js';
import { sessionStreamHub } from '../../lib/session-stream-hub.js';
import { parseJsonValue } from '../../lib/json.js';
import { sessionEventRepository } from '../../repositories/session-event-repository.js';

function deriveCreatedAt(event: SessionEvent) {
  switch (event.type) {
    case 'run.created':
      return event.run.createdAt;
    case 'run.completed':
    case 'run.blocked':
    case 'run.failed':
      return event.run.endedAt ?? event.run.updatedAt;
    case 'run.cancelled':
      return event.run.cancelledAt ?? event.run.endedAt ?? event.run.updatedAt;
    case 'message.created':
      return event.message.createdAt;
    case 'approval.created':
      return event.approval.createdAt;
    case 'tool.completed':
    case 'tool.pending':
      return event.toolCall.updatedAt;
    case 'session.updated':
      return event.updatedAt ?? event.timestamp ?? new Date().toISOString();
    case 'session.recovered':
      return event.recoveredAt;
    case 'session.resumable': {
      const checkpoint = event.checkpoint;

      if (typeof checkpoint === 'string') {
        return (
          parseJsonValue<SessionCheckpoint | null>(checkpoint, null)
            ?.updatedAt ?? new Date().toISOString()
        );
      }

      if (
        checkpoint &&
        typeof checkpoint === 'object' &&
        'updatedAt' in checkpoint &&
        typeof checkpoint.updatedAt === 'string'
      ) {
        return checkpoint.updatedAt;
      }

      return new Date().toISOString();
    }
    default:
      return new Date().toISOString();
  }
}

function deriveMetadata(event: SessionEvent) {
  switch (event.type) {
    case 'run.created':
      return {
        entityId: event.run.id,
        entityType: 'agent_run',
        headline: 'Run created'
      };
    case 'run.completed':
      return {
        entityId: event.run.id,
        entityType: 'agent_run',
        headline: 'Run completed'
      };
    case 'run.cancelled':
      return {
        detailText: event.reason,
        entityId: event.run.id,
        entityType: 'agent_run',
        headline: 'Run cancelled'
      };
    case 'run.blocked':
      return {
        detailText: event.error,
        entityId: event.run.id,
        entityType: 'agent_run',
        headline: 'Run blocked',
        level: 'warning' as const
      };
    case 'run.failed':
      return {
        detailText: event.error,
        entityId: event.run.id,
        entityType: 'agent_run',
        headline: 'Run failed',
        level: 'error' as const
      };
    case 'message.created':
      return {
        entityId: event.message.id,
        entityType: 'message',
        headline: `${event.message.role} message created`
      };
    case 'message.cancelled':
      return {
        entityId: event.messageId,
        entityType: 'message',
        headline: 'Message cancelled'
      };
    case 'tool.pending':
      return {
        detailText: event.toolCall.toolName,
        entityId: event.toolCall.id,
        entityType: 'tool_call',
        headline: 'Tool pending approval'
      };
    case 'approval.created':
      return {
        entityId: event.approval.id,
        entityType: 'approval',
        headline: 'Approval created'
      };
    case 'approval.resolved':
      return {
        detailText: event.decision,
        entityId: event.approvalId,
        entityType: 'approval',
        headline: 'Approval resolved'
      };
    case 'tool.running':
      return {
        entityId: event.toolCallId,
        entityType: 'tool_call',
        headline: 'Tool running'
      };
    case 'tool.completed':
      return {
        entityId: event.toolCall.id,
        entityType: 'tool_call',
        headline: 'Tool completed'
      };
    case 'tool.failed':
      return {
        detailText: event.error,
        entityId: event.toolCallId,
        entityType: 'tool_call',
        headline: 'Tool failed',
        level: 'error' as const
      };
    case 'session.recovered':
      return {
        detailText: event.diagnostics?.join('; '),
        entityId: event.sessionId,
        entityType: 'session',
        headline: 'Session recovered',
        level: 'warning' as const
      };
    case 'session.resumable':
      return {
        entityId: event.sessionId,
        entityType: 'session',
        headline: 'Session checkpoint updated'
      };
    case 'session.updated':
      return {
        entityId: event.sessionId,
        entityType: 'session',
        headline: 'Session updated'
      };
    default:
      return {
        entityId: event.sessionId,
        entityType: 'session'
      };
  }
}

function deriveRunId(event: SessionEvent) {
  if ('runId' in event) {
    return event.runId;
  }

  if (
    event.type === 'run.created' ||
    event.type === 'run.completed' ||
    event.type === 'run.blocked' ||
    event.type === 'run.cancelled' ||
    event.type === 'run.failed'
  ) {
    return event.run.id;
  }

  if (event.type === 'message.created') {
    return event.message.runId;
  }

  if (event.type === 'tool.pending' || event.type === 'tool.completed') {
    return event.toolCall.runId;
  }

  if (event.type === 'approval.created') {
    return event.approval.runId;
  }

  return undefined;
}

export const sessionEventService = {
  append(event: SessionEvent): SessionEventEnvelope {
    const runId = deriveRunId(event);
    const envelope = sessionEventRepository.append({
      createdAt: deriveCreatedAt(event),
      event,
      ...deriveMetadata(event),
      runId,
      sessionId: event.sessionId
    });

    Database.effect(() => {
      sessionStreamHub.publish(envelope);
    });

    return envelope;
  },

  publishPersisted(envelope: SessionEventEnvelope) {
    sessionStreamHub.publish(envelope);
  },

  publishPersistedMany(envelopes: Iterable<SessionEventEnvelope>) {
    for (const envelope of envelopes) {
      sessionStreamHub.publish(envelope);
    }
  },

  listAfterSequence(sessionId: string, afterSequenceNo: number) {
    return sessionEventRepository.listAfterSequence(sessionId, afterSequenceNo);
  }
};
