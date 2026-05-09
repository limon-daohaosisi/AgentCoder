import { createServerTestEnvironment } from './server-test-helpers.js';

const environment = createServerTestEnvironment('opencode-server-db-test-');

process.env.DATABASE_PATH = environment.databasePath;

const [
  { app },
  { sqlite },
  { ServiceError },
  { buildSessionCheckpoint },
  { agentRunService },
  { fileSnapshotService },
  { messageService },
  { messagePartService },
  { sessionInteractionService },
  { toolStateService },
  { sessionEventService },
  { sessionRecoveryService },
  { sessionService },
  { workspaceService }
] = await Promise.all([
  import('../app.js'),
  import('../db/client.js'),
  import('../lib/service-error.js'),
  import('@opencode/agent'),
  import('../services/agent/run-service.js'),
  import('../services/agent/file-snapshot-service.js'),
  import('../services/session/message/service.js'),
  import('../services/session/message/part-service.js'),
  import('../services/agent/interaction-service.js'),
  import('../services/agent/tool-state-service.js'),
  import('../services/session-events/event-service.js'),
  import('../services/session/recovery-service.js'),
  import('../services/session/service.js'),
  import('../services/workspace/service.js')
]);

const partService = {
  ...messagePartService,
  ...toolStateService
};

try {
  sqlite.exec(environment.migrationSql);
} catch (error) {
  if (!(error instanceof Error) || !/already exists/u.test(error.message)) {
    throw error;
  }
}

process.once('exit', () => {
  try {
    sqlite.close();
  } catch {
    // Ignore duplicate-close during test teardown.
  }

  environment.cleanup();
});

export const dbTestContext = {
  agentRunService,
  app,
  buildSessionCheckpoint,
  environment,
  fileSnapshotService,
  ServiceError,
  messageService,
  messagePartService,
  partService,
  sessionEventService,
  sessionInteractionService,
  sessionRecoveryService,
  sessionService,
  sqlite,
  toolStateService,
  workspaceService
};

export function resetTestDatabase() {
  sqlite.exec('DELETE FROM workspaces;');
}
