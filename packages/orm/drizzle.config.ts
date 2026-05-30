import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { defineConfig } from 'drizzle-kit';

const processWithLoadEnvFile = process as typeof process & {
  loadEnvFile?: (path?: string) => unknown;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../');

function loadEnvFileFallback(envFilePath: string) {
  const parsed = parseEnv(readFileSync(envFilePath, 'utf8'));

  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

for (const envFileName of ['.env.local', '.env']) {
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

export default defineConfig({
  out: './src',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? '../../apps/server/data/opencode.db'
  },
  introspect: {
    casing: 'camel'
  },
  tablesFilter: ['*', '!atlas_schema_revisions'],
  verbose: true,
  strict: true
});
