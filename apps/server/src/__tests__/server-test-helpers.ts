import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../../../..');

function runGitSetup(args: string[], cwd: string) {
  try {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
  } catch (error) {
    const execError = error as Error & {
      code?: string;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
    };

    if (execError.code === 'EPERM') {
      return;
    }

    throw error;
  }
}

export function createServerTestEnvironment(prefix: string) {
  const testRoot = mkdtempSync(path.join(tmpdir(), prefix));
  const databasePath = path.join(testRoot, 'opencode-test.db');
  const workspaceRoot = path.join(testRoot, 'workspace');

  mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
  writeFileSync(
    path.join(workspaceRoot, 'package.json'),
    '{"name":"workspace-test"}\n'
  );
  writeFileSync(
    path.join(workspaceRoot, 'src', 'index.ts'),
    'export const ok = true;\n'
  );
  runGitSetup(['init'], workspaceRoot);
  runGitSetup(['config', 'user.email', 'tests@example.com'], workspaceRoot);
  runGitSetup(['config', 'user.name', 'OpenCode Tests'], workspaceRoot);
  runGitSetup(['add', '.'], workspaceRoot);
  runGitSetup(['commit', '-m', 'init'], workspaceRoot);

  const migrationsDir = path.join(repoRoot, 'packages/db/migrations');
  const migrationSql = readdirSync(migrationsDir)
    .filter((filename) => filename.endsWith('.sql'))
    .sort()
    .map((filename) => readFileSync(path.join(migrationsDir, filename), 'utf8'))
    .join('\n');

  return {
    cleanup() {
      rmSync(testRoot, { force: true, recursive: true });
    },
    databasePath,
    migrationSql,
    testRoot,
    workspaceRoot
  };
}

export async function parseJson<T>(
  response: Response
): Promise<{ data?: T; error?: string }> {
  return (await response.json()) as { data?: T; error?: string };
}
