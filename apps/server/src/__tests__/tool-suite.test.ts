import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { readFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  applyPatchToolDefinition,
  bashToolDefinition,
  editToolDefinition,
  globToolDefinition,
  grepToolDefinition,
  readToolDefinition,
  writeToolDefinition,
  type FileSnapshotArtifact,
  type FileSnapshotStoreLookup,
  type ToolExecutionContext
} from '@opencode/agent';

function createSnapshotLookup(input: {
  artifactId?: string;
  content: string;
  fullRead: boolean;
  mtimeMs: number;
  path: string;
  size: number;
}): FileSnapshotStoreLookup {
  return {
    artifactId: input.artifactId ?? 'snapshot-1',
    snapshot: {
      fullRead: input.fullRead,
      mtimeMs: input.mtimeMs,
      path: input.path,
      readAt: '2026-05-09T00:00:00.000Z',
      sha256: createHash('sha256').update(input.content).digest('hex'),
      size: input.size,
      truncated: false,
      version: 1
    }
  };
}

function createToolContext(input: {
  getLatestForPath?: (args: {
    path: string;
    requireFullRead?: boolean;
    sessionId: string;
  }) => Promise<FileSnapshotStoreLookup | null>;
  workspaceRoot: string;
}) {
  const createdSnapshots: FileSnapshotArtifact[] = [];
  const context: ToolExecutionContext = {
    abortSignal: undefined,
    diagnostics: { collectForFiles: async () => [] },
    fileSnapshots: {
      create: async ({ snapshot }) => {
        createdSnapshots.push(snapshot);
        return { artifactId: `artifact-${createdSnapshots.length}` };
      },
      getLatestForPath: input.getLatestForPath ?? (async () => null)
    },
    now: () => '2026-05-09T00:00:00.000Z',
    sessionId: 'session-test',
    services: {},
    toolCallId: 'tool-call-test',
    workspaceRoot: input.workspaceRoot
  };

  return { context, createdSnapshots };
}

function createWorkspaceFixture(prefix: string) {
  const workspaceRoot = path.join(
    tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}`
  );

  mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
  writeFileSync(path.join(workspaceRoot, 'src', 'index.ts'), 'line1\nline2\n');
  writeFileSync(
    path.join(workspaceRoot, 'src', 'search.ts'),
    'const alpha = 1;\nconst beta = 2;\n'
  );

  return {
    cleanup() {
      rmSync(workspaceRoot, { force: true, recursive: true });
    },
    workspaceRoot
  };
}

type ApplyPatchApproval = {
  additions: number;
  deletions: number;
  diff: string;
  files: Array<{
    additions: number;
    beforeFingerprint?: {
      exists: boolean;
      mtimeMs?: number;
      sha256?: string;
      size?: number;
    };
    change: 'add' | 'delete' | 'move' | 'update';
    deletions: number;
    destinationFingerprint?: {
      exists: boolean;
      mtimeMs?: number;
      sha256?: string;
      size?: number;
    };
    diff: string;
    movePath?: string;
    overwritesDestination: boolean;
    path: string;
    relativePath: string;
  }>;
  summary: string;
};

test('read tool reads directories and creates file snapshots for files', async () => {
  const fixture = createWorkspaceFixture('opencode-read-tool');

  try {
    const { context, createdSnapshots } = createToolContext({
      workspaceRoot: fixture.workspaceRoot
    });
    const directoryResult = await readToolDefinition.execute({
      context,
      input: { filePath: 'src' }
    });

    assert.equal(directoryResult.type, 'directory');
    assert.deepEqual(directoryResult.entries, ['index.ts', 'search.ts']);
    assert.equal(createdSnapshots.length, 0);

    const fileResult = await readToolDefinition.execute({
      context,
      input: { filePath: 'src/index.ts', limit: 1, offset: 1 }
    });

    assert.equal(fileResult.type, 'file');
    assert.equal(fileResult.fullRead, false);
    assert.equal(fileResult.truncated, true);
    assert.equal(createdSnapshots.length, 1);
    assert.equal(createdSnapshots[0]?.path, 'src/index.ts');
    assert.equal(createdSnapshots[0]?.fullRead, false);
  } finally {
    fixture.cleanup();
  }
});

test('glob tool sorts results by most recent mtime', async () => {
  const fixture = createWorkspaceFixture('opencode-glob-tool');

  try {
    const newerPath = path.join(fixture.workspaceRoot, 'src', 'newer.ts');
    writeFileSync(newerPath, 'export const newer = true;\n');
    const now = new Date();
    const future = new Date(now.getTime() + 2_000);
    await utimes(newerPath, future, future);
    const { context } = createToolContext({
      workspaceRoot: fixture.workspaceRoot
    });
    const output = await globToolDefinition.execute({
      context,
      input: { pattern: '*.ts', path: 'src' }
    });

    assert.equal(output.results[0], 'src/newer.ts');
    assert.equal(output.truncated, false);
  } finally {
    fixture.cleanup();
  }
});

test('grep tool returns matches with file paths and line numbers', async () => {
  const fixture = createWorkspaceFixture('opencode-grep-tool');

  try {
    const { context } = createToolContext({
      workspaceRoot: fixture.workspaceRoot
    });
    const output = await grepToolDefinition.execute({
      context,
      input: { include: '*.ts', path: 'src', pattern: 'beta' }
    });

    assert.equal(output.totalMatches, 1);
    assert.equal(output.matches[0]?.path, 'src/search.ts');
    assert.equal(output.matches[0]?.line, 2);
  } finally {
    fixture.cleanup();
  }
});

test('glob and grep support brace patterns via fallback matcher', async () => {
  const fixture = createWorkspaceFixture('opencode-brace-patterns');

  try {
    writeFileSync(
      path.join(fixture.workspaceRoot, 'src', 'component.tsx'),
      'export const beta = true;\n'
    );
    const { context } = createToolContext({
      workspaceRoot: fixture.workspaceRoot
    });
    const globOutput = await globToolDefinition.execute({
      context,
      input: { pattern: '*.{ts,tsx}', path: 'src' }
    });
    const grepOutput = await grepToolDefinition.execute({
      context,
      input: { include: '*.{ts,tsx}', path: 'src', pattern: 'beta' }
    });

    assert.deepEqual(globOutput.results, [
      'src/component.tsx',
      'src/index.ts',
      'src/search.ts'
    ]);
    assert.equal(grepOutput.totalMatches, 2);
    assert.deepEqual(
      grepOutput.matches.map((match) => match.path),
      ['src/component.tsx', 'src/search.ts']
    );
  } finally {
    fixture.cleanup();
  }
});

test('grep rejects invalid regex instead of returning empty results', async () => {
  const fixture = createWorkspaceFixture('opencode-grep-invalid-regex');

  try {
    const { context } = createToolContext({
      workspaceRoot: fixture.workspaceRoot
    });

    await assert.rejects(
      grepToolDefinition.execute({
        context,
        input: { include: '*.ts', path: 'src', pattern: '[' }
      }),
      /Invalid regular expression|ripgrep grep failed/u
    );
  } finally {
    fixture.cleanup();
  }
});

test('glob rejects invalid glob patterns instead of returning empty results', async () => {
  const fixture = createWorkspaceFixture('opencode-glob-invalid-pattern');

  try {
    const { context } = createToolContext({
      workspaceRoot: fixture.workspaceRoot
    });

    await assert.rejects(
      globToolDefinition.execute({
        context,
        input: { pattern: '[', path: 'src' }
      }),
      /ripgrep glob failed|regex parse error|unclosed character class|[Mm]issing closing/u
    );
  } finally {
    fixture.cleanup();
  }
});

test('workspace path resolution rejects symlink escapes for read, write, and bash workdir', async () => {
  const fixture = createWorkspaceFixture('opencode-symlink-escape');

  try {
    const outsideRoot = path.join(
      tmpdir(),
      `opencode-symlink-outside-${process.pid}-${Date.now()}`
    );
    mkdirSync(outsideRoot, { recursive: true });
    writeFileSync(path.join(outsideRoot, 'secret.txt'), 'secret\n');
    symlinkSync(outsideRoot, path.join(fixture.workspaceRoot, 'link'), 'dir');
    const { context } = createToolContext({
      workspaceRoot: fixture.workspaceRoot
    });

    await assert.rejects(
      readToolDefinition.execute({
        context,
        input: { filePath: 'link/secret.txt' }
      }),
      /Path escapes workspace root/u
    );

    await assert.rejects(
      writeToolDefinition.buildApproval!({
        context,
        input: { content: 'nope\n', filePath: 'link/new.txt' }
      }),
      /Path escapes workspace root/u
    );

    await assert.rejects(
      bashToolDefinition.buildApproval!({
        context,
        input: {
          command: 'pwd',
          description: 'Print working directory',
          workdir: 'link'
        }
      }),
      /Path escapes workspace root/u
    );

    rmSync(outsideRoot, { force: true, recursive: true });
  } finally {
    fixture.cleanup();
  }
});

test('write tool rejects partial-read snapshots for existing files', async () => {
  const fixture = createWorkspaceFixture('opencode-write-partial');

  try {
    const absolutePath = path.join(fixture.workspaceRoot, 'src', 'index.ts');
    const content = await readFile(absolutePath, 'utf8');
    const fileStat = await stat(absolutePath);
    const { context } = createToolContext({
      getLatestForPath: async () =>
        createSnapshotLookup({
          content,
          fullRead: false,
          mtimeMs: fileStat.mtimeMs,
          path: 'src/index.ts',
          size: fileStat.size
        }),
      workspaceRoot: fixture.workspaceRoot
    });

    await assert.rejects(
      writeToolDefinition.buildApproval!({
        context,
        input: { content: 'line1\nchanged\n', filePath: 'src/index.ts' }
      }),
      /partially read/u
    );
  } finally {
    fixture.cleanup();
  }
});

test('edit tool rejects stale snapshots and supports replaceAll', async () => {
  const fixture = createWorkspaceFixture('opencode-edit-tool');

  try {
    const absolutePath = path.join(fixture.workspaceRoot, 'src', 'index.ts');
    writeFileSync(absolutePath, 'same\nsame\n');
    const content = await readFile(absolutePath, 'utf8');
    const fileStat = await stat(absolutePath);

    const staleContext = createToolContext({
      getLatestForPath: async () => ({
        artifactId: 'stale',
        snapshot: {
          ...createSnapshotLookup({
            content,
            fullRead: true,
            mtimeMs: fileStat.mtimeMs,
            path: 'src/index.ts',
            size: fileStat.size
          }).snapshot,
          sha256: 'stale'
        }
      }),
      workspaceRoot: fixture.workspaceRoot
    }).context;

    await assert.rejects(
      editToolDefinition.buildApproval!({
        context: staleContext,
        input: {
          filePath: 'src/index.ts',
          newString: 'done',
          oldString: 'same'
        }
      }),
      /changed since it was last read/u
    );

    const { context } = createToolContext({
      getLatestForPath: async () =>
        createSnapshotLookup({
          content,
          fullRead: true,
          mtimeMs: fileStat.mtimeMs,
          path: 'src/index.ts',
          size: fileStat.size
        }),
      workspaceRoot: fixture.workspaceRoot
    });
    const result = await editToolDefinition.execute({
      context,
      input: {
        filePath: 'src/index.ts',
        newString: 'done',
        oldString: 'same',
        replaceAll: true
      }
    });

    assert.equal(result.matches, 2);
    assert.equal(readFileSync(absolutePath, 'utf8'), 'done\ndone\n');
  } finally {
    fixture.cleanup();
  }
});

test('apply_patch tool supports add, update, and delete', async () => {
  const fixture = createWorkspaceFixture('opencode-apply-patch');

  try {
    writeFileSync(
      path.join(fixture.workspaceRoot, 'src', 'delete.ts'),
      'obsolete\n'
    );
    const { context, createdSnapshots } = createToolContext({
      workspaceRoot: fixture.workspaceRoot
    });
    const result = await applyPatchToolDefinition.execute({
      context,
      input: {
        patchText: [
          '*** Begin Patch',
          '*** Add File: src/created.ts',
          '+export const created = true;',
          '*** Delete File: src/delete.ts',
          '*** Update File: src/index.ts',
          '@@',
          '-line2',
          '+updated',
          '*** End Patch'
        ].join('\n')
      }
    });

    assert.equal(
      readFileSync(
        path.join(fixture.workspaceRoot, 'src', 'created.ts'),
        'utf8'
      ),
      'export const created = true;\n'
    );
    assert.equal(
      readFileSync(path.join(fixture.workspaceRoot, 'src', 'index.ts'), 'utf8'),
      'line1\nupdated\n'
    );
    assert.throws(
      () =>
        readFileSync(
          path.join(fixture.workspaceRoot, 'src', 'delete.ts'),
          'utf8'
        ),
      /ENOENT/u
    );
    assert.equal(result.files.length, 3);
    assert.equal(createdSnapshots.length, 2);
  } finally {
    fixture.cleanup();
  }
});

test('apply_patch buildApproval returns lightweight payload with fingerprints', async () => {
  const fixture = createWorkspaceFixture('opencode-apply-patch-approval');

  try {
    writeFileSync(
      path.join(fixture.workspaceRoot, 'src', 'delete.ts'),
      'obsolete\n'
    );
    const { context } = createToolContext({
      workspaceRoot: fixture.workspaceRoot
    });
    const approval = (await applyPatchToolDefinition.buildApproval!({
      context,
      input: {
        patchText: [
          '*** Begin Patch',
          '*** Add File: src/created.ts',
          '+export const created = true;',
          '*** Delete File: src/delete.ts',
          '*** Update File: src/index.ts',
          '@@',
          '-line2',
          '+updated',
          '*** End Patch'
        ].join('\n')
      }
    })) as ApplyPatchApproval;

    assert.equal(approval.files.length, 3);
    assert.match(approval.diff, /Index: src\/index\.ts/u);
    assert.equal('before' in approval.files[0]!, false);
    assert.equal('after' in approval.files[0]!, false);
    const addFile = approval.files.find((file) => file.change === 'add');
    const updateFile = approval.files.find((file) => file.change === 'update');

    assert.deepEqual(addFile?.destinationFingerprint, { exists: false });
    assert.equal(updateFile?.beforeFingerprint?.exists, true);
    assert.equal(typeof updateFile?.beforeFingerprint?.sha256, 'string');
  } finally {
    fixture.cleanup();
  }
});

test('apply_patch rejects stale approval payload when file changes after approval', async () => {
  const fixture = createWorkspaceFixture('opencode-apply-patch-stale');

  try {
    const { context } = createToolContext({
      workspaceRoot: fixture.workspaceRoot
    });
    const input = {
      patchText: [
        '*** Begin Patch',
        '*** Update File: src/index.ts',
        '@@',
        '-line2',
        '+updated',
        '*** End Patch'
      ].join('\n')
    };
    const approvalPayload = (await applyPatchToolDefinition.buildApproval!({
      context,
      input
    })) as ApplyPatchApproval;

    writeFileSync(
      path.join(fixture.workspaceRoot, 'src', 'index.ts'),
      'line1\nline2 changed elsewhere\n'
    );

    await assert.rejects(
      applyPatchToolDefinition.execute({
        approvalPayload,
        context,
        input
      }),
      /Patch no longer matches the approved file state/u
    );
  } finally {
    fixture.cleanup();
  }
});

test('apply_patch rejects Add File when target already exists', async () => {
  const fixture = createWorkspaceFixture('opencode-apply-patch-add-exists');

  try {
    const { context } = createToolContext({
      workspaceRoot: fixture.workspaceRoot
    });

    await assert.rejects(
      applyPatchToolDefinition.buildApproval!({
        context,
        input: {
          patchText: [
            '*** Begin Patch',
            '*** Add File: src/index.ts',
            '+replacement',
            '*** End Patch'
          ].join('\n')
        }
      }),
      /Add File target already exists/u
    );
  } finally {
    fixture.cleanup();
  }
});

test('apply_patch supports move patches and records destination metadata', async () => {
  const fixture = createWorkspaceFixture('opencode-apply-patch-move');

  try {
    writeFileSync(path.join(fixture.workspaceRoot, 'src', 'move.ts'), 'from\n');
    const { context, createdSnapshots } = createToolContext({
      workspaceRoot: fixture.workspaceRoot
    });
    const input = {
      patchText: [
        '*** Begin Patch',
        '*** Update File: src/move.ts',
        '*** Move to: src/moved.ts',
        '@@',
        '-from',
        '+to',
        '*** End Patch'
      ].join('\n')
    };
    const approvalPayload = (await applyPatchToolDefinition.buildApproval!({
      context,
      input
    })) as ApplyPatchApproval;
    const result = await applyPatchToolDefinition.execute({
      approvalPayload,
      context,
      input
    });

    assert.equal(
      readFileSync(path.join(fixture.workspaceRoot, 'src', 'moved.ts'), 'utf8'),
      'to\n'
    );
    assert.throws(
      () =>
        readFileSync(
          path.join(fixture.workspaceRoot, 'src', 'move.ts'),
          'utf8'
        ),
      /ENOENT/u
    );
    assert.equal(result.files[0]?.change, 'move');
    assert.equal(result.files[0]?.movePath, 'src/moved.ts');
    assert.equal(createdSnapshots.length, 1);
    assert.equal(createdSnapshots[0]?.path, 'src/moved.ts');
  } finally {
    fixture.cleanup();
  }
});

test('apply_patch rejects duplicate targets and empty update chunks', async () => {
  const fixture = createWorkspaceFixture('opencode-apply-patch-invalid');

  try {
    const { context } = createToolContext({
      workspaceRoot: fixture.workspaceRoot
    });

    await assert.rejects(
      applyPatchToolDefinition.buildApproval!({
        context,
        input: {
          patchText: [
            '*** Begin Patch',
            '*** Update File: src/index.ts',
            '@@',
            '-line2',
            '+updated',
            '*** Update File: src/index.ts',
            '@@',
            '-updated',
            '+again',
            '*** End Patch'
          ].join('\n')
        }
      }),
      /Duplicate patch/u
    );

    await assert.rejects(
      applyPatchToolDefinition.buildApproval!({
        context,
        input: {
          patchText: [
            '*** Begin Patch',
            '*** Update File: src/index.ts',
            '*** End Patch'
          ].join('\n')
        }
      }),
      /requires at least one @@ chunk/u
    );
  } finally {
    fixture.cleanup();
  }
});
