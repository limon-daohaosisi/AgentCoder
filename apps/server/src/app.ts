import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { agentRoutes } from './routes/agent/agent.route.js';
import { approvalRoutes } from './routes/approvals/approvals.route.js';
import { sessionRoutes } from './routes/sessions/sessions.route.js';
import { workspaceRoutes } from './routes/workspaces/workspaces.route.js';

const appInstance = new Hono()
  .use('/api/*', cors())
  .get('/health', (c) =>
    c.json({
      status: 'ok',
      timestamp: new Date().toISOString()
    })
  )
  .route('/api/workspaces', workspaceRoutes)
  .route('/api/sessions', sessionRoutes)
  .route('/api/sessions', agentRoutes)
  .route('/api/approvals', approvalRoutes);

export const app = appInstance;
export type AppType = typeof appInstance;
