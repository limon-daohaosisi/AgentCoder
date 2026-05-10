import type {
  ApprovalDto,
  ResumeSessionDto,
  SessionDto,
  ToolCallDto
} from '@opencode/shared';
import {
  parseSessionCheckpoint,
  validateApprovalResume
} from '@opencode/agent';
import { ServiceError } from '../../lib/service-error.js';
import { approvalRepository } from '../../repositories/approval-repository.js';
import { sessionRepository } from '../../repositories/session-repository.js';
import { toolCallRepository } from '../../repositories/tool-call-repository.js';
import { messagePartService } from './message/part-service.js';

function buildResumeFailure(session: SessionDto): ResumeSessionDto {
  const pendingApprovals = approvalRepository.listPendingBySession(session.id);

  return {
    canResume: false,
    checkpoint: session.lastCheckpointJson,
    pendingApprovals,
    session
  };
}

function buildResumeSuccess(session: SessionDto): ResumeSessionDto {
  const pendingApprovals = approvalRepository.listPendingBySession(session.id);

  return {
    canResume: true,
    checkpoint: session.lastCheckpointJson,
    pendingApprovals,
    session
  };
}

export const sessionResumeService = {
  assertApprovalResumeReady(input: {
    approval: ApprovalDto;
    toolCall: ToolCallDto;
  }) {
    const session = sessionRepository.getById(input.approval.sessionId);

    if (!session) {
      throw new ServiceError(
        `Session not found: ${input.approval.sessionId}`,
        404
      );
    }

    const checkpoint = parseSessionCheckpoint(session.lastCheckpointJson);
    const part = checkpoint?.partId
      ? messagePartService.getPart(checkpoint.partId)
      : null;
    const validation = validateApprovalResume({
      approval: input.approval,
      checkpoint,
      part,
      pendingApprovals: approvalRepository.listPendingBySession(session.id),
      session,
      toolCall: input.toolCall
    });

    if (!validation.ok) {
      throw new ServiceError(validation.reason, 409);
    }

    return validation.context;
  },

  resumeSession(session: SessionDto): ResumeSessionDto {
    if (session.status !== 'waiting_approval') {
      return buildResumeFailure(session);
    }

    const checkpoint = parseSessionCheckpoint(session.lastCheckpointJson);

    if (checkpoint?.kind !== 'waiting_approval') {
      return buildResumeFailure(session);
    }

    const approval = checkpoint.approvalId
      ? approvalRepository.getById(checkpoint.approvalId)
      : null;
    const toolCall = checkpoint.toolCallId
      ? toolCallRepository.getById(checkpoint.toolCallId)
      : null;
    const part = checkpoint.partId
      ? messagePartService.getPart(checkpoint.partId)
      : null;
    const validation = validateApprovalResume({
      approval,
      checkpoint,
      part,
      pendingApprovals: approvalRepository.listPendingBySession(session.id),
      session,
      toolCall
    });

    return validation.ok
      ? buildResumeSuccess(session)
      : buildResumeFailure(session);
  }
};
