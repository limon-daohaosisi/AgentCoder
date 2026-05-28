import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bashToolDefinition } from '@opencode/agent';

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('runCommandTool abort kills the spawned shell process group', async (t) => {
  if (process.platform === 'win32') {
    t.skip('process group termination is POSIX-specific');
    return;
  }

  const workspaceRoot = path.join(
    tmpdir(),
    `opencode-run-command-abort-${process.pid}-${Date.now()}`
  );
  const markerPath = path.join(workspaceRoot, 'child-finished.txt');

  mkdirSync(workspaceRoot, { recursive: true });

  try {
    const controller = new AbortController();
    const command = `node -e 'setTimeout(() => require("fs").writeFileSync(${JSON.stringify(
      markerPath
    )}, "alive"), 1500)'`;
    const promise = bashToolDefinition.execute({
      context: {
        abortSignal: controller.signal,
        diagnostics: { collectForFiles: async () => [] },
        fileSnapshots: {
          create: async () => ({ artifactId: '' }),
          getLatestForPath: async () => null
        },
        now: () => new Date().toISOString(),
        planContext: undefined,
        sessionId: 'session-test',
        services: {},
        toolCallId: 'tool-call-test',
        workspaceRoot
      },
      input: {
        command,
        description: 'Abort test command',
        timeoutMs: 10_000
      }
    });
    const rejection = assert.rejects(promise, /Run cancelled by user/u);

    await wait(100);
    controller.abort(new Error('Run cancelled by user'));

    await rejection;
    await wait(1_900);

    assert.throws(() => readFileSync(markerPath, 'utf8'), /ENOENT/u);
  } finally {
    rmSync(workspaceRoot, { force: true, recursive: true });
  }
});

test('runCommandTool rejects immediately when signal is already aborted', async () => {
  const workspaceRoot = path.join(
    tmpdir(),
    `opencode-run-command-preabort-${process.pid}-${Date.now()}`
  );

  mkdirSync(workspaceRoot, { recursive: true });

  try {
    const controller = new AbortController();

    controller.abort(new Error('Run cancelled by user'));

    await assert.rejects(
      bashToolDefinition.execute({
        context: {
          abortSignal: controller.signal,
          diagnostics: { collectForFiles: async () => [] },
          fileSnapshots: {
            create: async () => ({ artifactId: '' }),
            getLatestForPath: async () => null
          },
          now: () => new Date().toISOString(),
          planContext: undefined,
          sessionId: 'session-test',
          services: {},
          toolCallId: 'tool-call-test',
          workspaceRoot
        },
        input: {
          command: 'node -e "process.exit(0)"',
          description: 'Pre-abort test command',
          timeoutMs: 1_000
        }
      }),
      /Run cancelled by user/u
    );
  } finally {
    rmSync(workspaceRoot, { force: true, recursive: true });
  }
});

test('runCommandTool truncates large output and keeps full output on disk', async () => {
  const workspaceRoot = path.join(
    tmpdir(),
    `opencode-run-command-large-output-${process.pid}-${Date.now()}`
  );

  mkdirSync(workspaceRoot, { recursive: true });

  try {
    const result = await bashToolDefinition.execute({
      context: {
        abortSignal: undefined,
        diagnostics: { collectForFiles: async () => [] },
        fileSnapshots: {
          create: async () => ({ artifactId: '' }),
          getLatestForPath: async () => null
        },
        now: () => new Date().toISOString(),
        planContext: undefined,
        sessionId: 'session-test',
        services: {},
        toolCallId: 'tool-call-test',
        workspaceRoot
      },
      input: {
        command: `node -e "process.stdout.write('x'.repeat(40000))"`,
        description: 'Emit large stdout payload',
        timeoutMs: 5_000
      }
    });

    assert.equal(result.truncated, true);
    assert.equal(result.stdout.length, 30_000);
    assert.equal(typeof result.stdoutOutputPath, 'string');
    assert.equal(result.stdoutTotalBytes, 40_000);
    assert.equal(readFileSync(result.stdoutOutputPath!, 'utf8').length, 40_000);
  } finally {
    rmSync(workspaceRoot, { force: true, recursive: true });
  }
});

test('runCommandTool rejects interactive commands with a clear message', async () => {
  const workspaceRoot = path.join(
    tmpdir(),
    `opencode-run-command-interactive-${process.pid}-${Date.now()}`
  );

  mkdirSync(workspaceRoot, { recursive: true });

  try {
    await assert.rejects(
      bashToolDefinition.execute({
        context: {
          abortSignal: undefined,
          diagnostics: { collectForFiles: async () => [] },
          fileSnapshots: {
            create: async () => ({ artifactId: '' }),
            getLatestForPath: async () => null
          },
          now: () => new Date().toISOString(),
          planContext: undefined,
          sessionId: 'session-test',
          services: {},
          toolCallId: 'tool-call-test',
          workspaceRoot
        },
        input: {
          command: 'vim README.md',
          description: 'Open editor',
          timeoutMs: 1_000
        }
      }),
      /not supported in the non-interactive bash tool/u
    );
  } finally {
    rmSync(workspaceRoot, { force: true, recursive: true });
  }
});
