import { randomUUID } from 'node:crypto';
import type { FileSnapshotArtifact } from '@opencode/agent';
import { artifactRepository } from '../../repositories/artifact-repository.js';

function isFileSnapshotPayload(value: unknown): value is FileSnapshotArtifact {
  return (
    typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    'sha256' in value &&
    'fullRead' in value &&
    typeof (value as { path?: unknown }).path === 'string'
  );
}

export const fileSnapshotService = {
  async createFromRead(input: {
    sessionId: string;
    snapshot: FileSnapshotArtifact;
    toolCallId: string;
  }) {
    const artifact = artifactRepository.create({
      createdAt: input.snapshot.readAt,
      id: randomUUID(),
      kind: 'file_snapshot',
      payload: input.snapshot as unknown as Record<string, unknown>,
      sessionId: input.sessionId,
      title: input.snapshot.path,
      toolCallId: input.toolCallId
    });

    return { artifactId: artifact.id };
  },

  async getLatestForPath(input: {
    path: string;
    requireFullRead?: boolean;
    sessionId: string;
  }) {
    const artifacts = artifactRepository.listBySessionKind(
      input.sessionId,
      'file_snapshot'
    );

    for (const artifact of artifacts) {
      if (!isFileSnapshotPayload(artifact.payload)) {
        continue;
      }

      const snapshot = artifact.payload;

      if (snapshot.path !== input.path) {
        continue;
      }

      if (input.requireFullRead && !snapshot.fullRead) {
        continue;
      }

      return {
        artifactId: artifact.id,
        snapshot
      };
    }

    return null;
  },

  listRecentBySession(input: { limit: number; sessionId: string }) {
    return artifactRepository
      .listBySessionKind(input.sessionId, 'file_snapshot')
      .filter((artifact) => isFileSnapshotPayload(artifact.payload))
      .slice(0, input.limit)
      .map((artifact) => ({
        artifactId: artifact.id,
        snapshot: artifact.payload as FileSnapshotArtifact
      }));
  }
};
