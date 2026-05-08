import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionStreamHub } from '../lib/session-stream-hub.js';

function createEnvelope(sessionId: string, sequenceNo: number) {
  return {
    createdAt: `2026-04-21T10:00:0${sequenceNo}.000Z`,
    event: {
      sessionId,
      type: 'session.updated' as const,
      updatedAt: `2026-04-21T10:00:0${sequenceNo}.000Z`
    },
    sequenceNo
  };
}

test('sessionStreamHub buffers drained events and resolves pending readers', async () => {
  const sessionId = `session-buffered-${Date.now()}`;
  const subscription = sessionStreamHub.subscribe(sessionId);
  const firstEnvelope = createEnvelope(sessionId, 1);
  const secondEnvelope = createEnvelope(sessionId, 2);

  sessionStreamHub.publish(firstEnvelope);
  assert.deepEqual(subscription.drain(), [firstEnvelope]);

  const nextEnvelopePromise = subscription.next();
  sessionStreamHub.publish(secondEnvelope);

  assert.deepEqual(await nextEnvelopePromise, secondEnvelope);
  subscription.unsubscribe();
});

test('sessionStreamHub rejects pending readers on unsubscribe and abort', async () => {
  const unsubscribedSessionId = `session-unsub-${Date.now()}`;
  const unsubscribedSubscription = sessionStreamHub.subscribe(
    unsubscribedSessionId
  );
  const pendingAfterUnsubscribe = unsubscribedSubscription.next();

  unsubscribedSubscription.unsubscribe();

  await assert.rejects(pendingAfterUnsubscribe, /Session stream aborted\./);
  await assert.rejects(
    unsubscribedSubscription.next(),
    /Session stream aborted\./
  );

  const abortedSessionId = `session-abort-${Date.now()}`;
  const abortedSubscription = sessionStreamHub.subscribe(abortedSessionId);
  const abortController = new AbortController();
  const pendingAfterAbort = abortedSubscription.next(abortController.signal);

  abortController.abort();

  await assert.rejects(pendingAfterAbort, /Session stream aborted\./);
  abortedSubscription.unsubscribe();
});
