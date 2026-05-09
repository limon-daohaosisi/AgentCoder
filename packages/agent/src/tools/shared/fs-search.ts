import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { picomatch } from './picomatch.js';

export async function listFilesRecursively(root: string): Promise<string[]> {
  const results: string[] = [];
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        queue.push(absolutePath);
      } else if (entry.isFile()) {
        results.push(absolutePath);
      }
    }
  }

  return results;
}

export function compileGlobMatcher(globPattern: string) {
  const matcher = picomatch(globPattern, {
    dot: true,
    posixSlashes: true,
    strictBrackets: true
  });

  return (filePath: string) => matcher(filePath.replaceAll('\\', '/'));
}

export async function searchFileContents(input: {
  files: string[];
  pattern: RegExp;
}) {
  const matches: Array<{ absolutePath: string; line: number; text: string }> =
    [];

  for (const absolutePath of input.files) {
    const content = await readFile(absolutePath, 'utf8');
    const lines = content.replaceAll('\r\n', '\n').split('\n');

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';

      if (input.pattern.test(line)) {
        matches.push({ absolutePath, line: index + 1, text: line });
      }
      input.pattern.lastIndex = 0;
    }
  }

  return matches;
}

export async function sortFilesByMtime(paths: string[]) {
  return Promise.all(
    paths.map(async (absolutePath) => ({
      absolutePath,
      mtimeMs: (await stat(absolutePath)).mtimeMs
    }))
  );
}
