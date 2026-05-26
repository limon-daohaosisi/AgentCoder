import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SQLITE_URL_PREFIX = 'sqlite://';

function resolveSqliteFilePath(databaseUrl) {
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) {
    return null;
  }

  if (!databaseUrl.startsWith(SQLITE_URL_PREFIX)) {
    return null;
  }

  const rawPath = databaseUrl.slice(SQLITE_URL_PREFIX.length).split('?', 1)[0];

  if (rawPath.length === 0 || rawPath === ':memory:') {
    return null;
  }

  return resolve(rawPath);
}

export function ensureSqliteDatabaseUrlReady(databaseUrl) {
  const filePath = resolveSqliteFilePath(databaseUrl);

  if (filePath === null) {
    return;
  }

  mkdirSync(dirname(filePath), { recursive: true });
  closeSync(openSync(filePath, 'a'));
}
