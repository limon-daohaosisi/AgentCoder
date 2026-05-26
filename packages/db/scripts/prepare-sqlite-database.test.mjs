import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureSqliteDatabaseUrlReady } from './prepare-sqlite-database.mjs';

test('ensureSqliteDatabaseUrlReady creates missing parent directories and database file', () => {
  const previousCwd = process.cwd();
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencode-db-init-'));
  const relativeUrl = 'sqlite://nested/data/opencode.db';
  const expectedPath = join(tempRoot, 'nested/data/opencode.db');

  try {
    process.chdir(tempRoot);

    assert.equal(existsSync(expectedPath), false);

    ensureSqliteDatabaseUrlReady(relativeUrl);

    assert.equal(existsSync(expectedPath), true);
  } finally {
    process.chdir(previousCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
