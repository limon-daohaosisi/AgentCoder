import { streamSSE } from 'hono/streaming';
import { sessionInteractionService } from '../../services/agent/interaction-service.js';
import { agentRunService } from '../../services/agent/run-service.js';
import { parseLastEventId, writeEnvelope } from '../../lib/sse.js';
import { sessionStreamHub } from '../../lib/session-stream-hub.js';
import { appFactory } from '../../lib/factory.js';
import { isServiceError } from '../../lib/service-error.js';
import { createValidator } from '../../lib/validator.js';
import { sessionEventService } from '../../services/session-events/event-service.js';
import { sessionService } from '../../services/session/service.js';
import { AgentSchemas } from './agent.schema.js';

const KEEPALIVE_INTERVAL_MS = 15_000;

function isExpectedStreamAbort(error: unknown) {
  return (
    error instanceof Error &&
    (error.message === 'Session stream aborted.' ||
      error.message === 'SSE stream aborted.')
  );
}

function waitForKeepalive(signal: AbortSignal) {
  return new Promise<null>((resolve, reject) => {
    const abortHandler = () => {
      clearTimeout(timer);
      reject(new Error('SSE stream aborted.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abortHandler);

      if (signal.aborted) {
        reject(new Error('SSE stream aborted.'));
        return;
      }

      resolve(null);
    }, KEEPALIVE_INTERVAL_MS);

    signal.addEventListener('abort', abortHandler, { once: true });
  });
}

export const submitMessage = appFactory.createHandlers(
  createValidator.param(AgentSchemas.submitMessage.param),
  createValidator.json(AgentSchemas.submitMessage.json),
  async (c) => {
    const { sessionId } = c.req.valid('param');
    const payload = c.req.valid('json');

    try {
      const response = await sessionInteractionService.prompt({
        content: payload.content,
        sessionId
      });

      return c.json({ data: response }, 202);
    } catch (error) {
      if (isServiceError(error)) {
        return c.json({ error: error.message }, error.status);
      }

      throw error;
    }
  }
);

export const cancelCurrentRun = appFactory.createHandlers(
  createValidator.param(AgentSchemas.cancelCurrentRun.param),
  createValidator.json(AgentSchemas.cancelCurrentRun.json),
  async (c) => {
    const { sessionId } = c.req.valid('param');
    const payload = c.req.valid('json');

    try {
      const response = agentRunService.cancelCurrentRun({
        reason: payload.reason,
        sessionId
      });

      return c.json({ data: response }, 200);
    } catch (error) {
      if (isServiceError(error)) {
        return c.json({ error: error.message }, error.status);
      }

      throw error;
    }
  }
);

export const manualCompact = appFactory.createHandlers(
  createValidator.param(AgentSchemas.manualCompact.param),
  createValidator.json(AgentSchemas.manualCompact.json),
  async (c) => {
    const { sessionId } = c.req.valid('param');

    try {
      const response = await sessionInteractionService.manualCompact({
        sessionId
      });

      return c.json({ data: response }, 202);
    } catch (error) {
      if (isServiceError(error)) {
        return c.json({ error: error.message }, error.status);
      }

      throw error;
    }
  }
);

export const stream = appFactory.createHandlers(
  createValidator.param(AgentSchemas.stream.param),
  (c) => {
    const { sessionId } = c.req.valid('param');
    const session = sessionService.getSession(sessionId);

    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const signal = c.req.raw.signal;
    const lastEventId = parseLastEventId(c.req.header('Last-Event-ID'));

    return streamSSE(c, async (streamWriter) => {
      const subscription = sessionStreamHub.subscribe(sessionId);
      let latestSequenceNo = lastEventId;

      try {
        const replayEvents = sessionEventService.listAfterSequence(
          sessionId,
          lastEventId
        );

        for (const envelope of replayEvents) {
          await writeEnvelope(streamWriter, envelope);
          latestSequenceNo = envelope.sequenceNo;
        }

        while (!signal.aborted) {
          const pending = subscription
            .drain()
            .filter((envelope) => envelope.sequenceNo > latestSequenceNo);

          if (pending.length > 0) {
            for (const envelope of pending) {
              await writeEnvelope(streamWriter, envelope);
              latestSequenceNo = envelope.sequenceNo;
            }

            continue;
          }

          const nextEvent = await Promise.race([
            subscription.next(signal),
            waitForKeepalive(signal)
          ]);

          if (nextEvent === null) {
            await streamWriter.writeSSE({
              data: JSON.stringify({ timestamp: new Date().toISOString() }),
              event: 'keepalive'
            });
            continue;
          }

          if (nextEvent.sequenceNo <= latestSequenceNo) {
            continue;
          }

          await writeEnvelope(streamWriter, nextEvent);
          latestSequenceNo = nextEvent.sequenceNo;
        }
      } catch (error) {
        if (!isExpectedStreamAbort(error)) {
          throw error;
        }
      } finally {
        subscription.unsubscribe();
      }
    });
  }
);
