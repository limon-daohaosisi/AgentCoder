import { loadWorkspaceEnv } from './load-env.js';

loadWorkspaceEnv();

const [{ serve }, { app }, { sessionRecoveryService }] = await Promise.all([
  import('@hono/node-server'),
  import('./app.js'),
  import('./services/session/recovery-service.js')
]);

const port = Number(process.env.PORT ?? 3001);

async function main() {
  try {
    const report = sessionRecoveryService.recoverInterruptedSessionsOnStartup();
    console.log('Startup recovery completed', report);
  } catch (error) {
    console.error('Startup recovery failed; continuing server startup.', error);
  }

  serve(
    {
      fetch: app.fetch,
      port
    },
    () => {
      console.log(`OpenCode server listening on http://localhost:${port}`);
    }
  );
}

void main();
