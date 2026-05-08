import { appFactory } from '../../lib/factory.js';
import { isServiceError } from '../../lib/service-error.js';
import { createValidator } from '../../lib/validator.js';
import { messageService } from '../../services/session/message/service.js';
import { sessionService } from '../../services/session/service.js';
import { SessionsSchemas } from './sessions.schema.js';

export const list = appFactory.createHandlers(
  createValidator.query(SessionsSchemas.list.query),
  (c) => {
    const { workspaceId } = c.req.valid('query');
    return c.json({ data: sessionService.listSessions(workspaceId) });
  }
);

export const create = appFactory.createHandlers(
  createValidator.json(SessionsSchemas.create.json),
  async (c) => {
    const payload = c.req.valid('json');

    try {
      const session = sessionService.createSession(payload);
      return c.json({ data: session }, 201);
    } catch (error) {
      if (isServiceError(error)) {
        return c.json({ error: error.message }, error.status);
      }

      throw error;
    }
  }
);

export const getById = appFactory.createHandlers(
  createValidator.param(SessionsSchemas.byId.param),
  (c) => {
    const { sessionId } = c.req.valid('param');
    const session = sessionService.getSession(sessionId);

    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    return c.json({ data: session });
  }
);

export const listMessages = appFactory.createHandlers(
  createValidator.param(SessionsSchemas.byId.param),
  (c) => {
    const { sessionId } = c.req.valid('param');

    if (!sessionService.getSession(sessionId)) {
      return c.json({ error: 'Session not found' }, 404);
    }

    return c.json({ data: messageService.listMessages(sessionId) });
  }
);

export const resume = appFactory.createHandlers(
  createValidator.param(SessionsSchemas.byId.param),
  (c) => {
    const { sessionId } = c.req.valid('param');
    return c.json({ data: sessionService.resumeSession(sessionId) });
  }
);
