import type {
  CreateSessionInput,
  SessionCheckpoint,
  SessionDto
} from '@opencode/shared';
import type { SessionStatus } from '@opencode/shared';
import { randomUUID } from 'node:crypto';
import { stringifyJsonValue } from '../../lib/json.js';
import { ServiceError } from '../../lib/service-error.js';
import { sessionRepository } from '../../repositories/session-repository.js';
import { workspaceRepository } from '../../repositories/workspace-repository.js';
import { sessionResumeService } from './resume-service.js';

type UpdateSessionRuntimeStateInput = {
  currentTaskId?: null | string;
  lastCheckpoint?: null | SessionCheckpoint | string;
  lastErrorText?: null | string;
  sessionId: string;
  status?: SessionStatus;
};

function buildSessionTitle(goalText: string, title?: string): string {
  const trimmedTitle = title?.trim();

  if (trimmedTitle) {
    return trimmedTitle;
  }

  const firstLine = goalText
    .trim()
    .split(/\r?\n/u)
    .find((line) => line.trim().length > 0);

  const fallbackTitle = (firstLine ?? 'New session')
    .trim()
    .replace(/\s+/gu, ' ');
  return fallbackTitle.length <= 60
    ? fallbackTitle
    : `${fallbackTitle.slice(0, 57).trimEnd()}...`;
}

function serializeCheckpoint(
  checkpoint: null | SessionCheckpoint | string | undefined
) {
  if (checkpoint === undefined) {
    return undefined;
  }

  if (checkpoint === null) {
    return null;
  }

  return typeof checkpoint === 'string'
    ? checkpoint
    : stringifyJsonValue(checkpoint);
}

export const sessionService = {
  createSession(input: CreateSessionInput): SessionDto {
    const workspace = workspaceRepository.getById(input.workspaceId);

    if (!workspace) {
      throw new ServiceError(`Workspace not found: ${input.workspaceId}`, 404);
    }

    const now = new Date().toISOString();
    const session = sessionRepository.create({
      createdAt: now,
      goalText: input.goalText.trim(),
      id: randomUUID(),
      status: 'planning',
      title: buildSessionTitle(input.goalText, input.title),
      updatedAt: now,
      workspaceId: input.workspaceId
    });
    return session;
  },

  getSession(sessionId: string) {
    return sessionRepository.getById(sessionId);
  },

  listSessions(workspaceId: string) {
    return sessionRepository.listByWorkspace(workspaceId);
  },

  resumeSession(sessionId: string) {
    const session = sessionRepository.getById(sessionId);

    if (!session) {
      return {
        canResume: false
      };
    }

    return sessionResumeService.resumeSession(session);
  },

  updateSessionRuntimeState(
    input: UpdateSessionRuntimeStateInput
  ): SessionDto | null {
    return sessionRepository.updateResumeState({
      currentTaskId: input.currentTaskId,
      id: input.sessionId,
      lastCheckpointJson: serializeCheckpoint(input.lastCheckpoint),
      lastErrorText: input.lastErrorText,
      status: input.status,
      updatedAt: new Date().toISOString()
    });
  }
};
