import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { sessionEvents } from '@opencode/orm';
import { desc, eq } from 'drizzle-orm';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';
import { Database } from '../db/runtime.js';
import { db } from '../db/client.js';

const { environment, sessionService, workspaceService } = dbTestContext;

function createSession() {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });

  return sessionService.createSession({
    goalText: 'Exercise db runtime behavior',
    workspaceId: workspace.id
  });
}

beforeEach(() => {
  resetTestDatabase();
});

afterEach(() => {
  mock.restoreAll();
  resetTestDatabase();
});

test('Database.transaction runs after-commit effects only after outer commit', () => {
  const calls: string[] = [];

  const result = Database.transaction(() => {
    calls.push('outer:body');
    Database.effect(() => {
      calls.push('outer:effect');
    });

    const nested = Database.transaction(() => {
      calls.push('inner:body');
      Database.effect(() => {
        calls.push('inner:effect');
      });

      return 'nested-value';
    });

    calls.push(`nested:${nested}`);
    return 'outer-value';
  });

  assert.equal(result, 'outer-value');
  assert.deepEqual(calls, [
    'outer:body',
    'inner:body',
    'nested:nested-value',
    'outer:effect',
    'inner:effect'
  ]);
});

test('Database.transaction rollback discards effects and durable writes', () => {
  const session = createSession();
  let effectRan = false;

  assert.throws(() => {
    Database.transaction(() => {
      db.insert(sessionEvents)
        .values({
          createdAt: '2026-05-07T10:00:00.000Z',
          detailText: null,
          entityId: session.id,
          entityType: 'session',
          headline: 'rolled back',
          id: `${session.id}:1`,
          level: 'info',
          payloadJson: JSON.stringify({
            sessionId: session.id,
            type: 'session.updated',
            updatedAt: '2026-05-07T10:00:00.000Z'
          }),
          runId: null,
          sequenceNo: 1,
          sessionId: session.id,
          taskId: null,
          type: 'session.updated'
        })
        .run();

      Database.effect(() => {
        effectRan = true;
      });

      throw new Error('rollback-me');
    });
  }, /rollback-me/u);

  const persisted = db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, session.id))
    .all();

  assert.equal(effectRan, false);
  assert.deepEqual(persisted, []);
});

test('Database.transaction rejects async callbacks', () => {
  assert.throws(() => {
    Database.transaction((() =>
      Promise.resolve('not-allowed')) as unknown as () => string);
  }, /must be synchronous/u);
});

test('Database.effect outside transaction runs immediately and logs failures', () => {
  const warnings: unknown[][] = [];
  const warn = mock.method(console, 'warn', (...args: unknown[]) => {
    warnings.push(args);
  });
  let immediate = false;

  Database.effect(() => {
    immediate = true;
  });

  Database.effect(() => {
    throw new Error('effect-failed');
  });

  assert.equal(immediate, true);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warnings[0]?.[0] ?? ''), /after-commit effect failed/u);
});

test('Database.use inside transaction reuses the ambient transaction', () => {
  const session = createSession();

  Database.transaction(() => {
    Database.use((ambientDb) => {
      ambientDb
        .insert(sessionEvents)
        .values({
          createdAt: '2026-05-07T11:00:00.000Z',
          detailText: null,
          entityId: session.id,
          entityType: 'session',
          headline: 'ambient write',
          id: `${session.id}:1`,
          level: 'info',
          payloadJson: JSON.stringify({
            sessionId: session.id,
            type: 'session.updated',
            updatedAt: '2026-05-07T11:00:00.000Z'
          }),
          runId: null,
          sequenceNo: 1,
          sessionId: session.id,
          taskId: null,
          type: 'session.updated'
        })
        .run();
    });
  });

  const [persisted] = db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, session.id))
    .orderBy(desc(sessionEvents.sequenceNo))
    .all();

  assert.equal(persisted?.headline, 'ambient write');
});
