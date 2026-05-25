import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CreateWorkspaceInput,
  WorkspaceDirectoryBrowseDto,
  WorkspaceDto
} from '@opencode/shared';
import { ServiceError } from '../../lib/service-error.js';
import { workspaceRepository } from '../../repositories/workspace-repository.js';

type FileTreeNode = {
  children?: FileTreeNode[];
  name: string;
  type: 'directory' | 'file';
};

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.next',
  '.turbo',
  'dist',
  'node_modules'
]);
const REPO_ROOT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..'
);

function createFileTreeNode(
  rootPath: string,
  currentPath: string
): FileTreeNode {
  const stats = statSync(currentPath);
  const name =
    currentPath === rootPath
      ? path.basename(rootPath)
      : path.basename(currentPath);

  if (!stats.isDirectory()) {
    return {
      name,
      type: 'file'
    };
  }

  const children = readdirSync(currentPath, { withFileTypes: true })
    .filter((entry) => !IGNORED_DIRECTORY_NAMES.has(entry.name))
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    })
    .map((entry) =>
      createFileTreeNode(rootPath, path.join(currentPath, entry.name))
    );

  return {
    children,
    name,
    type: 'directory'
  };
}

function normalizeWorkspaceRootPath(rootPath: string): string {
  const absolutePath = path.resolve(rootPath);
  const canonicalPath = existsSync(absolutePath)
    ? realpathSync(absolutePath)
    : absolutePath;

  if (!existsSync(canonicalPath)) {
    throw new ServiceError(
      `Workspace path does not exist: ${canonicalPath}`,
      400
    );
  }

  if (!statSync(canonicalPath).isDirectory()) {
    throw new ServiceError(
      `Workspace path is not a directory: ${canonicalPath}`,
      400
    );
  }

  return canonicalPath;
}

function createDirectorySegments(
  currentPath: string
): WorkspaceDirectoryBrowseDto['segments'] {
  const parsedPath = path.parse(currentPath);
  const relativePath = currentPath.slice(parsedPath.root.length);
  const parts = relativePath.split(path.sep).filter(Boolean);
  const segments: WorkspaceDirectoryBrowseDto['segments'] = [
    {
      name: parsedPath.root || path.sep,
      path: parsedPath.root || path.sep
    }
  ];

  let cursor = parsedPath.root || path.sep;

  for (const part of parts) {
    cursor = path.join(cursor, part);
    segments.push({
      name: part,
      path: cursor
    });
  }

  return segments;
}

function createDirectoryBrowseResult(
  requestedPath?: string
): WorkspaceDirectoryBrowseDto {
  const currentPath = normalizeWorkspaceRootPath(
    requestedPath ?? REPO_ROOT_PATH
  );
  const directories = readdirSync(currentPath, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && !IGNORED_DIRECTORY_NAMES.has(entry.name)
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      name: entry.name,
      path: path.join(currentPath, entry.name)
    }));
  const parentPath = path.dirname(currentPath);

  return {
    currentPath,
    directories,
    parentPath: parentPath === currentPath ? undefined : parentPath,
    rootLabel: 'Current Repo',
    segments: createDirectorySegments(currentPath)
  };
}

export const workspaceService = {
  browseDirectory(requestedPath?: string) {
    return createDirectoryBrowseResult(requestedPath);
  },

  createWorkspace(input: CreateWorkspaceInput): WorkspaceDto {
    const canonicalPath = normalizeWorkspaceRootPath(input.rootPath);
    const now = new Date().toISOString();
    const existingWorkspace = workspaceRepository.getByRootPath(canonicalPath);

    if (existingWorkspace) {
      return (
        workspaceRepository.touchLastOpenedAt(existingWorkspace.id, now) ??
        existingWorkspace
      );
    }

    const name = path.basename(canonicalPath) || canonicalPath;

    return workspaceRepository.create({
      createdAt: now,
      id: randomUUID(),
      lastOpenedAt: now,
      name,
      rootPath: canonicalPath,
      updatedAt: now
    });
  },

  getTree(workspaceId: string) {
    const workspace = workspaceRepository.getById(workspaceId);

    if (!workspace) {
      throw new ServiceError(`Workspace not found: ${workspaceId}`, 404);
    }

    if (
      !existsSync(workspace.rootPath) ||
      !statSync(workspace.rootPath).isDirectory()
    ) {
      throw new ServiceError(
        `Workspace root path is unavailable: ${workspace.rootPath}`,
        500
      );
    }

    return [createFileTreeNode(workspace.rootPath, workspace.rootPath)];
  },

  getWorkspace(workspaceId: string) {
    return workspaceRepository.getById(workspaceId);
  },

  listWorkspaces() {
    return workspaceRepository.list();
  }
};
