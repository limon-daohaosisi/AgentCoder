import type {
  ApprovalDto,
  SubmitSessionMessageResponse,
  ToolCallDto
} from '@opencode/shared';
import { normalizePrompt, type Lifecycle } from '@opencode/agent';
import { approvalRepository } from '../../repositories/approval-repository.js';
import { toolCallRepository } from '../../repositories/tool-call-repository.js';
import { ServiceError } from '../../lib/service-error.js';
import { lifecycle } from '../../wiring/agent.js';
import { messageService } from '../session/message/service.js';
import type { SessionRunner } from './runner.js';
import { sessionRunner } from './runner.js';
import { sessionService } from '../session/service.js';
import { sessionResumeService } from '../session/resume-service.js';
import { sessionEventService } from '../session-events/event-service.js';
import { agentRunService } from './run-service.js';

type SubmitUserMessageInput = {
  content: string;
  sessionId: string;
};

export class SessionInteractionService {
  constructor(
    private readonly runner: SessionRunner = sessionRunner,
    private readonly runtimeLifecycle: Lifecycle = lifecycle
  ) {}

  async prompt(
    input: SubmitUserMessageInput
  ): Promise<SubmitSessionMessageResponse> {
    const session = sessionService.getSession(input.sessionId);

    if (!session) {
      throw new ServiceError(`Session not found: ${input.sessionId}`, 404);
    }

    if (session.status !== 'planning' && session.status !== 'idle') {
      throw new ServiceError(
        'Session cannot accept a new prompt in its current state.',
        409
      );
    }

    const response = await this.runner.ensureRunning(
      input.sessionId,
      async () => {
        const run = agentRunService.createRun({ sessionId: input.sessionId });
        const normalized = normalizePrompt({
          content: input.content,
          sessionId: input.sessionId
        });
        const message = messageService.createMessage({
          ...normalized.message,
          content: normalized.parts,
          runId: run.id
        });

        const triggeredRun =
          agentRunService.setTriggerMessage({
            runId: run.id,
            triggerMessageId: message.id
          }) ?? run;

        sessionEventService.append({
          run: triggeredRun,
          sessionId: input.sessionId,
          type: 'run.created'
        });

        sessionEventService.append({
          message,
          sessionId: input.sessionId,
          type: 'message.created'
        });

        const updatedSession = sessionService.updateSessionRuntimeState({
          lastErrorText: null,
          sessionId: input.sessionId,
          status: 'executing'
        });

        if (updatedSession) {
          sessionEventService.append({
            sessionId: updatedSession.id,
            runId: run.id,
            type: 'session.updated',
            updatedAt: updatedSession.updatedAt
          });
        }

        return {
          ctx: {
            accepted: true as const,
            message,
            run: triggeredRun
          },
          runId: triggeredRun.id
        };
      },
      async (ctx, signal) => {
        await this.runtimeLifecycle.startPromptRun({
          runId: ctx.run.id,
          signal,
          sessionId: input.sessionId
        });
      }
    );

    return response;
  }

  async resolveApproval(input: {
    approvalId: string;
    decision: 'approved' | 'rejected';
  }): Promise<{ approval: ApprovalDto; runId: string; toolCall: ToolCallDto }> {
    const approval = approvalRepository.getById(input.approvalId);

    if (!approval) {
      throw new ServiceError(`Approval not found: ${input.approvalId}`, 404);
    }

    if (approval.status !== 'pending') {
      throw new ServiceError('Approval has already been decided.', 409);
    }

    const toolCall = toolCallRepository.getById(approval.toolCallId);

    if (!toolCall) {
      throw new ServiceError(
        `Tool call not found: ${approval.toolCallId}`,
        404
      );
    }

    const runId = approval.runId ?? toolCall.runId;

    if (!runId) {
      throw new ServiceError('Approval is missing run id.', 409);
    }

    sessionResumeService.assertApprovalResumeReady({ approval, toolCall });

    const response = await this.runner.ensureRunning(
      approval.sessionId,
      async () => {
        const now = new Date().toISOString();
        const runningRun = agentRunService.markRunning({ runId });

        if (!runningRun) {
          throw new ServiceError('Run is no longer waiting for approval.', 409);
        }

        const updatedApproval = approvalRepository.updateDecision({
          decidedAt: now,
          id: approval.id,
          status: input.decision
        });
        const updatedToolCall = toolCall;

        if (!updatedApproval) {
          throw new ServiceError('Failed to persist approval decision.', 500);
        }

        const updatedSession = sessionService.updateSessionRuntimeState({
          lastCheckpoint: null,
          lastErrorText: null,
          sessionId: approval.sessionId,
          status: 'executing'
        });

        sessionEventService.append({
          approvalId: updatedApproval.id,
          decision: input.decision,
          runId,
          sessionId: approval.sessionId,
          type: 'approval.resolved'
        });

        if (updatedSession) {
          sessionEventService.append({
            runId,
            sessionId: approval.sessionId,
            type: 'session.updated',
            updatedAt: updatedSession.updatedAt
          });
        }

        return {
          ctx: {
            approval: updatedApproval,
            runId,
            toolCall: updatedToolCall
          },
          runId
        };
      },
      async (ctx, signal) => {
        await this.runtimeLifecycle.resumeApprovalRun({
          approval,
          decision: input.decision,
          runId: ctx.runId,
          signal,
          toolCall: ctx.toolCall
        });
      }
    );

    return response;
  }
}

export const sessionInteractionService = new SessionInteractionService();
