import { spawnSync } from 'node:child_process';
import { ensureSqliteDatabaseUrlReady } from './prepare-sqlite-database.mjs';

ensureSqliteDatabaseUrlReady(process.env.DATABASE_URL);

const result = spawnSync('atlas', ['migrate', 'apply', '--env', 'local'], {
  stdio: 'inherit',
  env: process.env
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
