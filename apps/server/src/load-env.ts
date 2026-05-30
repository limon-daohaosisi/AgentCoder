import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const processWithLoadEnvFile = process as typeof process & {
  loadEnvFile?: (path?: string) => unknown;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
const envFileNames = ['.env.local', '.env'];

function loadEnvFileFallback(envFilePath: string) {
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

    if (processWithLoadEnvFile.loadEnvFile) {
      processWithLoadEnvFile.loadEnvFile(envFilePath);
      continue;
    }

    loadEnvFileFallback(envFilePath);
  }
}
