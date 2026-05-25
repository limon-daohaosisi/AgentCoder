import { appFactory } from '../../lib/factory.js';
import { isServiceError } from '../../lib/service-error.js';
import { createValidator } from '../../lib/validator.js';
import { messageService } from '../../services/session/message/service.js';
import { planService } from '../../services/session/plan-service.js';
import { sessionRevertService } from '../../services/session/revert-service.js';
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

export const getPlanBoard = appFactory.createHandlers(
  createValidator.param(SessionsSchemas.byId.param),
  (c) => {
    const { sessionId } = c.req.valid('param');

    try {
      return c.json({ data: planService.getSessionPlanBoard(sessionId) });
    } catch (error) {
      if (isServiceError(error)) {
        return c.json({ error: error.message }, error.status);
      }

      throw error;
    }
  }
);

export const getPlanFile = appFactory.createHandlers(
  createValidator.param(SessionsSchemas.byId.param),
  async (c) => {
    const { sessionId } = c.req.valid('param');

    try {
      return c.json({ data: await planService.getSessionPlanFile(sessionId) });
    } catch (error) {
      if (isServiceError(error)) {
        return c.json({ error: error.message }, error.status);
      }

      throw error;
    }
  }
);

export const resume = appFactory.createHandlers(
  createValidator.param(SessionsSchemas.byId.param),
  (c) => {
    const { sessionId } = c.req.valid('param');
    return c.json({ data: sessionService.resumeSession(sessionId) });
  }
);

export const revert = appFactory.createHandlers(
  createValidator.param(SessionsSchemas.revert.param),
  createValidator.json(SessionsSchemas.revert.json),
  async (c) => {
    const { sessionId } = c.req.valid('param');
    const { messageId } = c.req.valid('json');

    try {
      return c.json({
        data: await sessionRevertService.revertToMessage({
          messageId,
          sessionId
        })
      });
    } catch (error) {
      if (isServiceError(error)) {
        return c.json({ error: error.message }, error.status);
      }

      throw error;
    }
  }
);

export const restoreRevert = appFactory.createHandlers(
  createValidator.param(SessionsSchemas.restoreRevert.param),
  createValidator.json(SessionsSchemas.restoreRevert.json),
  async (c) => {
    const { sessionId } = c.req.valid('param');

    try {
      return c.json({
        data: await sessionRevertService.restoreRevert({
          sessionId
        })
      });
    } catch (error) {
      if (isServiceError(error)) {
        return c.json({ error: error.message }, error.status);
      }

      throw error;
    }
  }
);
