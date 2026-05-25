import { Hono } from 'hono';
import * as handlers from './sessions.handler.js';

export const sessionRoutes = new Hono()
  .get('/', ...handlers.list)
  .post('/', ...handlers.create)
  .get('/:sessionId', ...handlers.getById)
  .get('/:sessionId/plan-board', ...handlers.getPlanBoard)
  .get('/:sessionId/plan-file', ...handlers.getPlanFile)
  .get('/:sessionId/messages', ...handlers.listMessages)
  .post('/:sessionId/revert', ...handlers.revert)
  .post('/:sessionId/revert/restore', ...handlers.restoreRevert)
  .post('/:sessionId/resume', ...handlers.resume);
