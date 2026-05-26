import { createHash } from 'node:crypto';
import { access, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ServiceError } from '../../lib/service-error.js';

const execFileAsync = promisify(execFile);

type SnapshotStoreState = {
  gitDir: string;
};

const snapshotStores = new Map<string, SnapshotStoreState>();

function workspaceKey(workspaceRoot: string) {
  return createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex');
}

function resolveSnapshotBaseDir() {
  const databasePath = process.env.DATABASE_PATH?.trim();

  if (databasePath) {
    return path.join(
      path.dirname(path.resolve(databasePath)),
      'workspace-snapshots'
    );
  }

  return path.join(tmpdir(), 'opencode-workspace-snapshots');
}

async function runGit(args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      env: {
        ...process.env,
        ...(env ?? {})
      }
    });

    return {
      code: 0,
      stderr: result.stderr,
      stdout: result.stdout
    };
  } catch (error) {
    const execError = error as Error & {
      code?: number;
      stderr?: string;
      stdout?: string;
    };

    return {
      code: execError.code ?? 1,
      stderr: execError.stderr ?? '',
      stdout: execError.stdout ?? ''
    };
  }
}

async function ensureSnapshotStore(workspaceRoot: string) {
  const key = workspaceKey(workspaceRoot);
  const existing = snapshotStores.get(key);

  if (existing) {
    return existing;
  }

  const root = path.join(resolveSnapshotBaseDir(), key);
  const gitDir = path.join(root, 'gitdir');
  await mkdir(gitDir, { recursive: true });
  const headPath = path.join(gitDir, 'HEAD');
  const needsInit = !(await access(headPath)
    .then(() => true)
    .catch(() => false));

  if (!needsInit) {
    const state = { gitDir };
    snapshotStores.set(key, state);
    return state;
  }

  const initResult = await runGit(['init', '--bare', gitDir], workspaceRoot);

  if (initResult.code !== 0) {
    await rm(root, { force: true, recursive: true });
    throw new ServiceError(
      `Failed to initialize workspace snapshot store: ${initResult.stderr || initResult.stdout || 'unknown error'}`,
      500
    );
  }

  const state = { gitDir };
  snapshotStores.set(key, state);
  return state;
}

async function stageWorkspace(workspaceRoot: string, gitDir: string) {
  const env = {
    GIT_DIR: gitDir,
    GIT_WORK_TREE: path.resolve(workspaceRoot)
  };

  const addResult = await runGit(['add', '-A', '.'], workspaceRoot, env);

  if (addResult.code !== 0) {
    throw new ServiceError(
      `Failed to stage workspace snapshot: ${addResult.stderr || addResult.stdout || 'unknown error'}`,
      500
    );
  }

  const writeTreeResult = await runGit(['write-tree'], workspaceRoot, env);

  if (writeTreeResult.code !== 0) {
    throw new ServiceError(
      `Failed to write workspace snapshot tree: ${writeTreeResult.stderr || writeTreeResult.stdout || 'unknown error'}`,
      500
    );
  }

  return writeTreeResult.stdout.trim();
}

function withNoQuotePath(args: string[]) {
  return ['-c', 'core.quotepath=false', ...args];
}

export const workspaceSnapshotService = {
  async diff(input: { snapshotId: string; workspaceRoot: string }) {
    const store = await ensureSnapshotStore(input.workspaceRoot);
    const env = {
      GIT_DIR: store.gitDir,
      GIT_WORK_TREE: path.resolve(input.workspaceRoot)
    };
    await stageWorkspace(input.workspaceRoot, store.gitDir);

    const diffResult = await runGit(
      withNoQuotePath(['diff', '--no-ext-diff', input.snapshotId, '--', '.']),
      input.workspaceRoot,
      env
    );

    if (diffResult.code !== 0) {
      throw new ServiceError(
        `Failed to diff workspace snapshot: ${diffResult.stderr || diffResult.stdout || 'unknown error'}`,
        500
      );
    }

    return diffResult.stdout.trim();
  },

  async restore(input: { snapshotId: string; workspaceRoot: string }) {
    const store = await ensureSnapshotStore(input.workspaceRoot);
    const env = {
      GIT_DIR: store.gitDir,
      GIT_WORK_TREE: path.resolve(input.workspaceRoot)
    };
    await stageWorkspace(input.workspaceRoot, store.gitDir);
    const changedFilesResult = await runGit(
      withNoQuotePath(['diff', '--name-only', input.snapshotId, '--', '.']),
      input.workspaceRoot,
      env
    );

    if (changedFilesResult.code !== 0) {
      throw new ServiceError(
        `Failed to enumerate workspace snapshot changes: ${changedFilesResult.stderr || changedFilesResult.stdout || 'unknown error'}`,
        500
      );
    }

    const changedFiles = changedFilesResult.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    for (const relativePath of changedFiles) {
      const checkoutResult = await runGit(
        withNoQuotePath(['checkout', input.snapshotId, '--', relativePath]),
        input.workspaceRoot,
        env
      );

      if (checkoutResult.code === 0) {
        continue;
      }

      const treeResult = await runGit(
        withNoQuotePath(['ls-tree', input.snapshotId, '--', relativePath]),
        input.workspaceRoot,
        env
      );

      if (treeResult.code === 0 && treeResult.stdout.trim()) {
        throw new ServiceError(
          `Failed to restore workspace snapshot: ${checkoutResult.stderr || checkoutResult.stdout || 'unknown error'}`,
          500
        );
      }

      await rm(path.join(input.workspaceRoot, relativePath), {
        force: true,
        recursive: true
      });
    }
  },

  async track(input: { workspaceRoot: string }) {
    const store = await ensureSnapshotStore(input.workspaceRoot);
    return stageWorkspace(input.workspaceRoot, store.gitDir);
  }
};
