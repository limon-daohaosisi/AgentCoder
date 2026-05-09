import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

export type FileSnapshotArtifact = {
  fullRead: boolean;
  lineCount?: number;
  mtimeMs: number;
  path: string;
  previewLimit?: number;
  previewOffset?: number;
  readAt: string;
  sha256: string;
  size: number;
  truncated: boolean;
  version: 1;
};

export type FileSnapshotStoreLookup = {
  artifactId: string;
  snapshot: FileSnapshotArtifact;
};

export type FileSnapshotStore = {
  create(input: {
    sessionId: string;
    snapshot: FileSnapshotArtifact;
    toolCallId: string;
  }): Promise<{ artifactId: string }>;
  getLatestForPath(input: {
    path: string;
    requireFullRead?: boolean;
    sessionId: string;
  }): Promise<FileSnapshotStoreLookup | null>;
};

export function sha256Text(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

export function buildFileSnapshotArtifact(input: {
  content: string;
  fullRead: boolean;
  lineCount?: number;
  path: string;
  previewLimit?: number;
  previewOffset?: number;
  readAt: string;
  size: number;
  statMtimeMs: number;
  truncated: boolean;
}): FileSnapshotArtifact {
  return {
    fullRead: input.fullRead,
    lineCount: input.lineCount,
    mtimeMs: input.statMtimeMs,
    path: input.path,
    previewLimit: input.previewLimit,
    previewOffset: input.previewOffset,
    readAt: input.readAt,
    sha256: sha256Text(input.content),
    size: input.size,
    truncated: input.truncated,
    version: 1
  };
}

export async function assertFreshSnapshot(input: {
  absolutePath: string;
  path: string;
  requireFullRead?: boolean;
  sessionId: string;
  store: FileSnapshotStore;
}) {
  const lookup = await input.store.getLatestForPath({
    path: input.path,
    requireFullRead: input.requireFullRead,
    sessionId: input.sessionId
  });

  if (!lookup) {
    throw new Error('File must be read before it can be modified.');
  }

  if (input.requireFullRead && !lookup.snapshot.fullRead) {
    throw new Error(
      'File was only partially read and must be fully read before it can be modified.'
    );
  }

  const [currentStat, currentContent] = await Promise.all([
    stat(input.absolutePath),
    readFile(input.absolutePath, 'utf8')
  ]);
  const currentHash = sha256Text(currentContent);

  if (
    lookup.snapshot.size !== currentStat.size ||
    lookup.snapshot.mtimeMs !== currentStat.mtimeMs ||
    lookup.snapshot.sha256 !== currentHash
  ) {
    throw new Error(
      'File changed since it was last read. Read it again before modifying it.'
    );
  }

  return {
    artifactId: lookup.artifactId,
    content: currentContent,
    snapshot: lookup.snapshot,
    stat: currentStat
  };
}
