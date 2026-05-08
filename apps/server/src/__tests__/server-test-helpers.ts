import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../../../..');

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
