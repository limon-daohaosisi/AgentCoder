import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
const envFileNames = ['.env.local', '.env'];

function loadEnvFileFallback(envFilePath) {
  const parsed = parseEnv(readFileSync(envFilePath, 'utf8'));

  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadWorkspaceEnv() {
  for (const envFileName of envFileNames) {
    const envFilePath = resolve(repoRoot, envFileName);

    if (!existsSync(envFilePath)) {
      continue;
    }

    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(envFilePath);
      continue;
    }

    loadEnvFileFallback(envFilePath);
  }
}
