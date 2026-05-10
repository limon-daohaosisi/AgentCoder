import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export function normalizeWorkspaceRelativePath(filePath: string) {
  return filePath.replaceAll('\\', '/');
}

function assertContainedWithinRoot(rootPath: string, targetPath: string) {
  const relativePath = path.relative(rootPath, targetPath);

  if (
    relativePath !== '' &&
    (relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath))
  ) {
    throw new Error('Path escapes workspace root.');
  }
}

async function findNearestExistingAncestor(targetPath: string) {
  let currentPath = targetPath;

  while (true) {
    try {
      await stat(currentPath);
      return currentPath;
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
    }

    const parentPath = path.dirname(currentPath);

    if (parentPath === currentPath) {
      throw new Error('Path escapes workspace root.');
    }

    currentPath = parentPath;
  }
}

export async function resolveWorkspacePath(
  workspaceRoot: string,
  filePath: string
): Promise<string> {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(
    path.isAbsolute(filePath) ? filePath : path.join(root, filePath)
  );

  const [rootRealPath, anchorRealPath] = await Promise.all([
    realpath(root),
    findNearestExistingAncestor(target).then((existingPath) =>
      realpath(existingPath)
    )
  ]);

  assertContainedWithinRoot(rootRealPath, anchorRealPath);

  return target;
}

export async function resolveWorkspaceDirectory(
  workspaceRoot: string,
  workdir?: string
): Promise<string> {
  const directoryPath = await resolveWorkspacePath(
    workspaceRoot,
    workdir ?? '.'
  );
  const directoryStat = await stat(directoryPath);

  if (!directoryStat.isDirectory()) {
    throw new Error('Path is not a directory.');
  }

  return directoryPath;
}

export function toWorkspaceRelativePath(
  workspaceRoot: string,
  absolutePath: string
): string {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(absolutePath);
  const relativePath = path.relative(root, target);

  if (relativePath === '') {
    return '.';
  }

  assertContainedWithinRoot(root, target);

  return normalizeWorkspaceRelativePath(relativePath);
}
