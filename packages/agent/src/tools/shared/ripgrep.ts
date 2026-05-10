import { spawn } from 'node:child_process';

export class RipgrepUnavailableError extends Error {
  constructor() {
    super('ripgrep is not available');
    this.name = 'RipgrepUnavailableError';
  }
}

export class RipgrepTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RipgrepTimeoutError';
  }
}

export type RipgrepCommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

export async function runRipgrepCommand(input: {
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<RipgrepCommandResult> {
  if (input.signal?.aborted) {
    throw new Error('Run cancelled by user');
  }

  return new Promise<RipgrepCommandResult>((resolve, reject) => {
    const child = spawn('rg', input.args, {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    function killChild(signal: NodeJS.Signals) {
      if (process.platform === 'win32') {
        child.kill();
        return;
      }

      child.kill(signal);
    }

    function cleanup() {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abortHandler);
    }

    function rejectOnce(error: Error) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    }

    function resolveOnce(result: RipgrepCommandResult) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(result);
    }

    function abortHandler() {
      killChild('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          killChild('SIGKILL');
        }
      }, 1_000).unref();
      rejectOnce(new Error('Run cancelled by user'));
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killChild('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          killChild('SIGKILL');
        }
      }, 1_000).unref();
    }, input.timeoutMs);

    input.signal?.addEventListener('abort', abortHandler, { once: true });

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        rejectOnce(new RipgrepUnavailableError());
        return;
      }

      rejectOnce(error);
    });

    child.on('close', (exitCode) => {
      if (timedOut) {
        rejectOnce(
          new RipgrepTimeoutError(
            stderr || `ripgrep timed out after ${input.timeoutMs}ms`
          )
        );
        return;
      }

      resolveOnce({
        exitCode: exitCode ?? 0,
        stderr,
        stdout
      });
    });
  });
}
