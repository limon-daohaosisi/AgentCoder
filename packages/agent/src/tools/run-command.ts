import { spawn } from 'node:child_process';
import { z } from 'zod';
import { assertSafeCommand } from './guards.js';
import type { ToolDefinition } from './types.js';

export type RunCommandToolInput = {
  command: string;
  timeoutMs: number | null;
};

export const runCommandInputSchema = z
  .object({
    command: z.string().trim().min(1),
    timeoutMs: z.number().int().positive().nullable()
  })
  .strict();

export const runCommandToolDefinition: ToolDefinition = {
  description:
    'Run a non-interactive shell command in the workspace. Requires user approval.',
  inputSchema: {
    additionalProperties: false,
    properties: {
      command: {
        description: 'A single shell command executed in the workspace root.',
        type: 'string'
      },
      timeoutMs: {
        description:
          'Timeout in milliseconds before the command is terminated. Use null for the default timeout.',
        type: ['integer', 'null']
      }
    },
    required: ['command', 'timeoutMs'],
    type: 'object'
  },
  name: 'run_command'
};

export async function runCommandTool(
  input: RunCommandToolInput,
  workspaceRoot: string,
  options: { signal?: AbortSignal } = {}
) {
  assertSafeCommand(input.command);

  if (options.signal?.aborted) {
    throw new Error('Run cancelled by user');
  }

  const timeoutMs = input.timeoutMs ?? 15_000;

  return new Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    const child = spawn(input.command, {
      cwd: workspaceRoot,
      detached: process.platform !== 'win32',
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    function killChild(signal: NodeJS.Signals) {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fallback to killing only the shell process if the process group is gone.
        }
      }

      child.kill(signal);
    }

    function cleanup() {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortHandler);
    }

    function rejectOnce(error: Error) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
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
      killChild('SIGTERM');
      rejectOnce(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    options.signal?.addEventListener('abort', abortHandler, { once: true });

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('exit', (exitCode) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      if (exitCode && exitCode !== 0) {
        reject(new Error(`Command exited with code ${exitCode}: ${stderr}`));
        return;
      }

      resolve({ exitCode, stderr, stdout });
    });

    child.on('error', (error) => {
      rejectOnce(error);
    });
  });
}
