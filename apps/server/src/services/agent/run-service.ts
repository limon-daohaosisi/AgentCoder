import { randomUUID } from 'node:crypto';
import type {
  AgentRunDto,
  CancelRunResponse,
  SessionCheckpoint,
  SessionDto
} from '@opencode/shared';
import { stringifyJsonValue } from '../../lib/json.js';
import { ServiceError } from '../../lib/service-error.js';
import { agentRunRepository } from '../../repositories/agent-run-repository.js';
import { approvalRepository } from '../../repositories/approval-repository.js';
import { messagePartRepository } from '../../repositories/message-part-repository.js';
import { messageRepository } from '../../repositories/message-repository.js';
import { toolCallRepository } from '../../repositories/tool-call-repository.js';
import { sessionService } from '../session/service.js';
import { sessionEventService } from '../session-events/event-service.js';
import type { SessionRunner } from './runner.js';
import { sessionRunner } from './runner.js';

const runCancelledText = 'Run cancelled by user';

function serializeCheckpoint(checkpoint: SessionCheckpoint | string) {
  return typeof checkpoint === 'string'
    ? checkpoint
    : stringifyJsonValue(checkpoint);
}

function appendSessionUpdated(session: SessionDto | null, runId?: string) {
  if (!session) {
    return;
  }

  sessionEventService.append({
    runId,
    sessionId: session.id,
    type: 'session.updated',
    updatedAt: session.updatedAt
  });
}

export class AgentRunService {
  constructor(private readonly runner: SessionRunner = sessionRunner) {}

  cancelCurrentRun(input: {
    reason?: string;
    sessionId: string;
  }): CancelRunResponse {
    const session = sessionService.getSession(input.sessionId);

    if (!session) {
      throw new ServiceError(`Session not found: ${input.sessionId}`, 404);
    }

    if (session.status === 'archived') {
      throw new ServiceError('Archived sessions cannot be cancelled.', 409);
    }

    const activeRunId = this.runner.getActiveRun(input.sessionId)?.runId;
    const activeRun = activeRunId
      ? agentRunRepository.getById(activeRunId)
      : agentRunRepository.getActiveBySession(input.sessionId);

    if (!activeRun) {
      return {
        cancelled: false,
        reason: 'no_active_run',
        session
      };
    }

    const reason = input.reason ?? runCancelledText;

    this.runner.cancel(input.sessionId, reason);
    const updatedRun = agentRunRepository.markCancelled({
      errorText: reason,
      id: activeRun.id,
      updatedAt: new Date().toISOString()
    });

    if (!updatedRun) {
      return {
        cancelled: false,
        reason: 'no_active_run',
        session: sessionService.getSession(input.sessionId) ?? session
      };
    }

    this.interruptOpenState(activeRun.id, reason);

    const updatedSession = sessionService.updateSessionRuntimeState({
      lastCheckpoint: null,
      lastErrorText: null,
      sessionId: input.sessionId,
      status: 'idle'
    });

    sessionEventService.append({
      reason,
      run: updatedRun,
      sessionId: input.sessionId,
      type: 'run.cancelled'
    });
    appendSessionUpdated(updatedSession, updatedRun.id);

    return {
      cancelled: true,
      reason:
        session.status === 'waiting_approval'
          ? 'approval_cancelled'
          : 'active_run_cancelled',
      run: updatedRun,
      session: updatedSession ?? session
    };
  }

  createRun(input: { sessionId: string }): AgentRunDto {
    const now = new Date().toISOString();

    return agentRunRepository.create({
      cancelledAt: null,
      createdAt: now,
      endedAt: null,
      errorText: null,
      id: randomUUID(),
      lastCheckpointJson: null,
      sessionId: input.sessionId,
      startedAt: now,
      status: 'running',
      triggerMessageId: null,
      updatedAt: now
    });
  }

  markBlocked(input: { errorText: string; runId: string }) {
    return agentRunRepository.markBlocked({
      errorText: input.errorText,
      id: input.runId,
      updatedAt: new Date().toISOString()
    });
  }

  markCancelled(input: { errorText?: null | string; runId: string }) {
    return agentRunRepository.markCancelled({
      errorText: input.errorText,
      id: input.runId,
      updatedAt: new Date().toISOString()
    });
  }

  markCompleted(input: { runId: string }) {
    return agentRunRepository.markCompleted({
      id: input.runId,
      updatedAt: new Date().toISOString()
    });
  }

  markFailed(input: { errorText: string; runId: string }) {
    return agentRunRepository.markFailed({
      errorText: input.errorText,
      id: input.runId,
      updatedAt: new Date().toISOString()
    });
  }

  markRunning(input: { runId: string }) {
    return agentRunRepository.markRunning({
      id: input.runId,
      updatedAt: new Date().toISOString()
    });
  }

  markWaitingApproval(input: {
    checkpoint: SessionCheckpoint | string;
    runId: string;
  }) {
    return agentRunRepository.markWaitingApproval({
      id: input.runId,
      lastCheckpointJson: serializeCheckpoint(input.checkpoint),
      updatedAt: new Date().toISOString()
    });
  }

  setTriggerMessage(input: { runId: string; triggerMessageId: string }) {
    return agentRunRepository.setTriggerMessage({
      id: input.runId,
      triggerMessageId: input.triggerMessageId,
      updatedAt: new Date().toISOString()
    });
  }

  private interruptOpenState(runId: string, reason: string) {
    const now = new Date().toISOString();
    const payload = { error: reason, ok: false };
    const approvals = approvalRepository.rejectPendingByRun({
      decidedAt: now,
      decisionReasonText: reason,
      runId
    });
    const messages = messageRepository.cancelRunningByRun({
      errorText: null,
      finishReason: 'cancelled',
      runId,
      updatedAt: now
    });
    const toolParts = messagePartRepository.interruptOpenToolPartsByRun({
      completedAt: now,
      errorText: reason,
      payload,
      runId
    });
    const toolCalls = toolCallRepository.failOpenByRun({
      completedAt: now,
      errorText: reason,
      result: payload,
      runId,
      updatedAt: now
    });

    for (const approval of approvals) {
      sessionEventService.append({
        approvalId: approval.id,
        decision: 'rejected',
        runId,
        sessionId: approval.sessionId,
        type: 'approval.resolved'
      });
    }

    for (const message of messages) {
      sessionEventService.append({
        messageId: message.id,
        runId,
        sessionId: message.sessionId,
        type: 'message.cancelled'
      });
    }

    for (const toolPart of toolParts) {
      sessionEventService.append({
        error: reason,
        runId,
        sessionId: toolPart.sessionId,
        toolCallId: toolPart.toolCallId,
        type: 'tool.failed'
      });
    }

    for (const toolCall of toolCalls) {
      if (toolParts.some((part) => part.toolCallId === toolCall.id)) {
        continue;
      }

      sessionEventService.append({
        error: reason,
        runId,
        sessionId: toolCall.sessionId,
        toolCallId: toolCall.id,
        type: 'tool.failed'
      });
    }
  }
}

export const agentRunService = new AgentRunService();
