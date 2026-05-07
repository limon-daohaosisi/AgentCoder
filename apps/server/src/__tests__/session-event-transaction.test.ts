import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';
import { Database } from '../db/runtime.js';
import { sessionStreamHub } from '../lib/session-stream-hub.js';

const { environment, sessionEventService, sessionService, workspaceService } =
  dbTestContext;

function createSession() {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });

  return sessionService.createSession({
    goalText: 'Exercise event transaction behavior',
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

test('sessionEventService.append does not publish until transaction commits', () => {
  const session = createSession();
  const subscription = sessionStreamHub.subscribe(session.id);

  Database.transaction(() => {
    sessionEventService.append({
      sessionId: session.id,
      type: 'session.updated',
      updatedAt: '2026-05-07T12:00:00.000Z'
    });

    assert.deepEqual(subscription.drain(), []);
  });

  assert.deepEqual(
    subscription.drain().map((envelope) => envelope.event.type),
    ['session.updated']
  );

  subscription.unsubscribe();
});

test('sessionEventService.append rollback does not leak live publish', () => {
  const session = createSession();
  const subscription = sessionStreamHub.subscribe(session.id);

  assert.throws(() => {
    Database.transaction(() => {
      sessionEventService.append({
        sessionId: session.id,
        type: 'session.updated',
        updatedAt: '2026-05-07T12:05:00.000Z'
      });

      throw new Error('rollback-event');
    });
  }, /rollback-event/u);

  assert.deepEqual(subscription.drain(), []);
  assert.deepEqual(sessionEventService.listAfterSequence(session.id, 0), []);

  subscription.unsubscribe();
});

test('failed live publish keeps durable event for replay and logs warning', () => {
  const session = createSession();
  const warnings: unknown[][] = [];
  const publish = mock.method(sessionStreamHub, 'publish', (() => {
    throw new Error('publish-broken');
  }) as typeof sessionStreamHub.publish);
  const warn = mock.method(console, 'warn', (...args: unknown[]) => {
    warnings.push(args);
  });

  const envelope = sessionEventService.append({
    sessionId: session.id,
    type: 'session.updated',
    updatedAt: '2026-05-07T12:10:00.000Z'
  });

  assert.equal(publish.mock.callCount(), 1);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warnings[0]?.[0] ?? ''), /after-commit effect failed/u);
  assert.deepEqual(sessionEventService.listAfterSequence(session.id, 0), [
    envelope
  ]);
});
