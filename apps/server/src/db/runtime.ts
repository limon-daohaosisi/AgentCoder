import { AsyncLocalStorage } from 'node:async_hooks';
import { db as rootDb } from './client.js';

type DatabaseHandle = typeof rootDb;
type AfterCommitEffect = () => void;

type TransactionContext = {
  effects: AfterCommitEffect[];
  tx: DatabaseHandle;
};

const transactionContext = new AsyncLocalStorage<TransactionContext>();

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function warnEffectFailure(error: unknown) {
  console.warn('Database after-commit effect failed:', error);
}

function runEffect(effect: AfterCommitEffect) {
  try {
    effect();
  } catch (error) {
    warnEffectFailure(error);
  }
}

function assertSynchronousTransactionResult<T>(value: T): T {
  if (isPromiseLike(value)) {
    throw new Error('Database.transaction() callback must be synchronous.');
  }

  return value;
}

export const Database = {
  use<T>(callback: (db: DatabaseHandle) => T): T {
    const context = transactionContext.getStore();
    return callback(context?.tx ?? rootDb);
  },

  transaction<T>(callback: () => T): T {
    const existing = transactionContext.getStore();

    if (existing) {
      return assertSynchronousTransactionResult(callback());
    }

    const effects: AfterCommitEffect[] = [];
    const result = rootDb.transaction((tx) => {
      const context: TransactionContext = {
        effects,
        tx: tx as unknown as DatabaseHandle
      };

      return transactionContext.run(context, () =>
        assertSynchronousTransactionResult(callback())
      );
    });

    for (const effect of effects) {
      runEffect(effect);
    }

    return result;
  },

  effect(callback: AfterCommitEffect) {
    const context = transactionContext.getStore();

    if (!context) {
      runEffect(callback);
      return;
    }

    context.effects.push(callback);
  }
};

export type { DatabaseHandle };
