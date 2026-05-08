import type { SessionEventEnvelope } from '@opencode/shared';

type Resolver = {
  reject: (error: Error) => void;
  resolve: (value: SessionEventEnvelope) => void;
};

function createAbortError() {
  return new Error('Session stream aborted.');
}

class SessionStreamSubscription {
  private closed = false;
  private pending: SessionEventEnvelope[] = [];
  private waiting = new Set<Resolver>();

  constructor(private readonly onClose: () => void) {}

  drain() {
    const events = [...this.pending];
    this.pending = [];
    return events;
  }

  next(signal?: AbortSignal): Promise<SessionEventEnvelope> {
    const nextEvent = this.pending.shift();

    if (nextEvent) {
      return Promise.resolve(nextEvent);
    }

    return new Promise<SessionEventEnvelope>((resolve, reject) => {
      if (this.closed) {
        reject(createAbortError());
        return;
      }

      const abortHandler = () => {
        this.waiting.delete(resolver);
        reject(createAbortError());
      };

      if (signal) {
        if (signal.aborted) {
          abortHandler();
          return;
        }

        signal.addEventListener('abort', abortHandler, { once: true });
      }

      const resolver: Resolver = {
        reject: (error) => {
          if (signal) {
            signal.removeEventListener('abort', abortHandler);
          }

          reject(error);
        },
        resolve: (value) => {
          if (signal) {
            signal.removeEventListener('abort', abortHandler);
          }

          resolve(value);
        }
      };

      this.waiting.add(resolver);
    });
  }

  push(event: SessionEventEnvelope) {
    if (this.closed) {
      return;
    }

    const iterator = this.waiting.values().next();

    if (!iterator.done) {
      const resolver = iterator.value;
      this.waiting.delete(resolver);
      resolver.resolve(event);
      return;
    }

    this.pending.push(event);
  }

  unsubscribe() {
    if (this.closed) {
      return;
    }

    this.closed = true;

    for (const resolver of this.waiting) {
      resolver.reject(createAbortError());
    }

    this.waiting.clear();
    this.onClose();
  }
}

class SessionStreamHub {
  private readonly subscriptions = new Map<
    string,
    Set<SessionStreamSubscription>
  >();

  publish(envelope: SessionEventEnvelope) {
    const subscribers = this.subscriptions.get(envelope.event.sessionId);

    if (!subscribers) {
      return;
    }

    for (const subscription of subscribers) {
      subscription.push(envelope);
    }
  }

  subscribe(sessionId: string) {
    const subscription = new SessionStreamSubscription(() => {
      const subscribers = this.subscriptions.get(sessionId);

      if (!subscribers) {
        return;
      }

      subscribers.delete(subscription);

      if (subscribers.size === 0) {
        this.subscriptions.delete(sessionId);
      }
    });

    const subscribers = this.subscriptions.get(sessionId);

    if (subscribers) {
      subscribers.add(subscription);
      return subscription;
    }

    this.subscriptions.set(sessionId, new Set([subscription]));
    return subscription;
  }
}

export const sessionStreamHub = new SessionStreamHub();
