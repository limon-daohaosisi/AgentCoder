import { spawnSync } from 'node:child_process';
import { loadWorkspaceEnv } from './load-env.mjs';

loadWorkspaceEnv();

const result = spawnSync('atlas', process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
