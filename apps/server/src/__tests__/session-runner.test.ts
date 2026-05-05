import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionRunner } from '../services/agent/runner.js';

function waitForBackgroundTurn() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

test('SessionRunner holds the lock for the detached run lifecycle', async () => {
  const runner = new SessionRunner();
  let releaseRun: () => void;
  let runStarted = false;
  const runFinished = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });

  const setupResult = await runner.ensureRunning(
    'session-1',
    async () => ({ ctx: 'ctx', runId: 'run-1' }),
    async (ctx, signal) => {
      assert.equal(ctx, 'ctx');
      assert.equal(signal.aborted, false);
      runStarted = true;
      await runFinished;
    }
  );

  assert.equal(setupResult, 'ctx');

  await waitForBackgroundTurn();

  assert.equal(runStarted, true);
  assert.equal(runner.busy('session-1'), true);
  await assert.rejects(
    () =>
      runner.ensureRunning(
        'session-1',
        async () => ({ ctx: 'other', runId: 'run-other' }),
        async () => {}
      ),
    /Session already has an active run/iu
  );

  releaseRun!();
  await waitForBackgroundTurn();

  assert.equal(runner.busy('session-1'), false);
});

test('SessionRunner releases the lock when setup fails', async () => {
  const runner = new SessionRunner();

  await assert.rejects(
    () =>
      runner.ensureRunning(
        'session-2',
        async () => {
          throw new Error('setup failed');
        },
        async () => {}
      ),
    /setup failed/iu
  );

  assert.equal(runner.busy('session-2'), false);
});

test('SessionRunner cancel aborts the active run signal', async () => {
  const runner = new SessionRunner();
  let releaseRun: () => void;
  const runFinished = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  let captureSignal!: (signal: AbortSignal) => void;
  const signalReady = new Promise<AbortSignal>((resolve) => {
    captureSignal = resolve;
  });

  await runner.ensureRunning(
    'session-3',
    async () => ({ ctx: 'ctx', runId: 'run-3' }),
    async (_ctx, signal) => {
      captureSignal(signal);
      await runFinished;
    }
  );

  await waitForBackgroundTurn();
  const observedSignal = await signalReady;

  assert.equal(runner.getActiveRun('session-3')?.runId, 'run-3');
  assert.equal(runner.cancel('session-3', 'stop now'), true);
  assert.equal(observedSignal.aborted, true);
  assert.equal(
    observedSignal.reason instanceof Error
      ? observedSignal.reason.message
      : observedSignal.reason,
    'stop now'
  );

  releaseRun!();
  await waitForBackgroundTurn();
  assert.equal(runner.busy('session-3'), false);
});
