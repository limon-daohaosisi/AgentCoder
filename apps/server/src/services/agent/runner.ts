import { ServiceError } from '../../lib/service-error.js';

type ActiveRun = {
  controller: AbortController;
  kind: 'active';
  runId: string;
  sessionId: string;
  startedAt: string;
};

type PendingSetupReservation = {
  kind: 'setup';
  reservedAt: string;
  sessionId: string;
};

type SessionRunEntry = ActiveRun | PendingSetupReservation;

export class SessionRunner {
  private readonly activeRuns = new Map<string, SessionRunEntry>();

  busy(sessionId: string) {
    return this.activeRuns.has(sessionId);
  }

  cancel(sessionId: string, reason = 'Run cancelled by user') {
    const activeRun = this.activeRuns.get(sessionId);

    if (!activeRun || activeRun.kind === 'setup') {
      return false;
    }

    activeRun.controller.abort(new Error(reason));
    return true;
  }

  getActiveRun(sessionId: string) {
    const activeRun = this.activeRuns.get(sessionId);

    if (!activeRun || activeRun.kind === 'setup') {
      return null;
    }

    return activeRun;
  }

  async ensureRunning<T>(
    sessionId: string,
    setup: () => Promise<{ ctx: T; runId: string }>,
    run: (ctx: T, signal: AbortSignal) => Promise<void>
  ): Promise<T> {
    if (this.activeRuns.has(sessionId)) {
      throw new ServiceError('Session already has an active run.', 409);
    }

    this.activeRuns.set(sessionId, {
      kind: 'setup',
      reservedAt: new Date().toISOString(),
      sessionId
    });

    try {
      const { ctx, runId } = await setup();
      const controller = new AbortController();

      this.activeRuns.set(sessionId, {
        controller,
        kind: 'active',
        runId,
        sessionId,
        startedAt: new Date().toISOString()
      });

      void Promise.resolve()
        .then(() => run(ctx, controller.signal))
        .finally(() => {
          this.activeRuns.delete(sessionId);
        });

      return ctx;
    } catch (error) {
      this.activeRuns.delete(sessionId);
      throw error;
    }
  }
}

export const sessionRunner = new SessionRunner();
