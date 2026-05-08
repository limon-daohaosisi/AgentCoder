import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runCommandTool } from '@opencode/agent';

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
    const promise = runCommandTool(
      {
        command,
        timeoutMs: 10_000
      },
      workspaceRoot,
      { signal: controller.signal }
    );
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
      runCommandTool(
        {
          command: 'node -e "process.exit(0)"',
          timeoutMs: 1_000
        },
        workspaceRoot,
        { signal: controller.signal }
      ),
      /Run cancelled by user/u
    );
  } finally {
    rmSync(workspaceRoot, { force: true, recursive: true });
  }
});
