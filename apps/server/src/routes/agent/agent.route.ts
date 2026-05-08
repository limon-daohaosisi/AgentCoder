import { Hono } from 'hono';
import * as handlers from './agent.handler.js';

export const agentRoutes = new Hono()
  .post('/:sessionId/messages', ...handlers.submitMessage)
  .post('/:sessionId/runs/current/cancel', ...handlers.cancelCurrentRun)
  .get('/:sessionId/stream', ...handlers.stream);
