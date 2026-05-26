import type {
  RestoreRevertResponse,
  RevertSessionResponse,
  SessionRevertDto
} from '@opencode/shared';
import { Database } from '../../db/runtime.js';
import { ServiceError } from '../../lib/service-error.js';
import { sessionRepository } from '../../repositories/session-repository.js';
import { agentRunRepository } from '../../repositories/agent-run-repository.js';
import { workspaceRepository } from '../../repositories/workspace-repository.js';
import { sessionEventService } from '../session-events/event-service.js';
import { messageService } from './message/service.js';
import { sessionService } from './service.js';
import { workspaceSnapshotService } from '../agent/workspace-snapshot-service.js';
import { sessionRunner } from '../agent/runner.js';

function getWorkspaceRoot(sessionId: string) {
  const session = sessionRepository.getById(sessionId);

  if (!session) {
    throw new ServiceError(`Session not found: ${sessionId}`, 404);
  }

  const workspace = workspaceRepository.getById(session.workspaceId);

  if (!workspace) {
    throw new ServiceError(`Workspace not found for session ${sessionId}`, 404);
  }

  return workspace.rootPath;
}

function ensureSessionCanRevert(sessionId: string) {
  if (
    sessionRunner.busy(sessionId) ||
    agentRunRepository.getActiveBySession(sessionId)
  ) {
    throw new ServiceError('Session already has an active run.', 409);
  }
}

export const sessionRevertService = {
  async restoreRevert(input: {
    sessionId: string;
  }): Promise<RestoreRevertResponse> {
    const session = sessionService.getSession(input.sessionId);

    if (!session) {
      throw new ServiceError(`Session not found: ${input.sessionId}`, 404);
    }

    if (!session.revert) {
      throw new ServiceError('Session is not reverted.', 409);
    }

    ensureSessionCanRevert(input.sessionId);

    if (!session.revert.redoSnapshotId) {
      throw new ServiceError('Redo snapshot is missing for this session.', 409);
    }

    const workspaceRoot = getWorkspaceRoot(input.sessionId);
    await workspaceSnapshotService.restore({
      snapshotId: session.revert.redoSnapshotId,
      workspaceRoot
    });

    const updatedSession = Database.transaction(() => {
      const cleared = sessionService.clearSessionRevert(input.sessionId);

      if (!cleared) {
        throw new ServiceError(`Session not found: ${input.sessionId}`, 404);
      }

      sessionEventService.append({
        sessionId: input.sessionId,
        type: 'session.revert_restored'
      });
      sessionEventService.append({
        sessionId: input.sessionId,
        type: 'session.updated',
        updatedAt: cleared.updatedAt
      });

      return cleared;
    });

    return {
      restored: true,
      session: updatedSession
    };
  },

  async revertToMessage(input: {
    messageId: string;
    sessionId: string;
  }): Promise<RevertSessionResponse> {
    const session = sessionService.getSession(input.sessionId);

    if (!session) {
      throw new ServiceError(`Session not found: ${input.sessionId}`, 404);
    }

    ensureSessionCanRevert(input.sessionId);

    const messages = messageService.listMessages(input.sessionId, {
      includeReverted: true
    });
    const targetMessage = messages.find(
      (message) => message.id === input.messageId
    );

    if (!targetMessage) {
      throw new ServiceError(`Message not found: ${input.messageId}`, 404);
    }

    if (targetMessage.role !== 'user') {
      throw new ServiceError(
        'Only user messages can be used as revert targets.',
        409
      );
    }

    const beforeSnapshotId = targetMessage.runtime?.beforeSnapshotId;

    if (!beforeSnapshotId) {
      throw new ServiceError(
        'Target message does not have a pre-message workspace snapshot.',
        409
      );
    }

    const workspaceRoot = getWorkspaceRoot(input.sessionId);
    const redoSnapshotId = await workspaceSnapshotService.track({
      workspaceRoot
    });
    const diffText = await workspaceSnapshotService.diff({
      snapshotId: beforeSnapshotId,
      workspaceRoot
    });

    await workspaceSnapshotService.restore({
      snapshotId: beforeSnapshotId,
      workspaceRoot
    });

    const revert: SessionRevertDto = {
      beforeSnapshotId,
      createdAt: new Date().toISOString(),
      diffText: diffText || undefined,
      redoSnapshotId,
      targetMessageId: input.messageId
    };

    const updatedSession = Database.transaction(() => {
      const reverted = sessionService.setSessionRevert({
        revert,
        sessionId: input.sessionId
      });

      if (!reverted) {
        throw new ServiceError(`Session not found: ${input.sessionId}`, 404);
      }

      sessionEventService.append({
        revert,
        sessionId: input.sessionId,
        type: 'session.reverted'
      });
      sessionEventService.append({
        sessionId: input.sessionId,
        type: 'session.updated',
        updatedAt: reverted.updatedAt
      });

      return reverted;
    });

    return {
      revert,
      session: updatedSession
    };
  }
};
