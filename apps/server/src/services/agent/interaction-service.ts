import type {
  ApprovalDto,
  MessagePart,
  SubmitSessionMessageResponse,
  ToolCallDto
} from '@opencode/shared';
import { Database } from '../../db/runtime.js';
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
import { toolStateService } from './tool-state-service.js';

type ResolveApprovalContext =
  | {
      approval: ApprovalDto;
      part: Extract<MessagePart, { type: 'tool' }>;
      runId: string;
      toolCall: ToolCallDto;
    }
  | {
      approval: ApprovalDto;
      runId: string;
      toolCall: ToolCallDto;
    };

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
        return Database.transaction(() => {
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
        });
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

    const resume = sessionResumeService.assertApprovalResumeReady({
      approval,
      toolCall
    });

    const response = await this.runner.ensureRunning<ResolveApprovalContext>(
      approval.sessionId,
      async () => {
        return Database.transaction(() => {
          const now = new Date().toISOString();
          const runningRun = agentRunService.markRunning({ runId });

          if (!runningRun) {
            throw new ServiceError(
              'Run is no longer waiting for approval.',
              409
            );
          }

          const updatedApproval = approvalRepository.updateDecision({
            decidedAt: now,
            id: approval.id,
            status: input.decision
          });

          if (!updatedApproval) {
            throw new ServiceError('Failed to persist approval decision.', 500);
          }

          const rejectedToolUpdate =
            input.decision === 'rejected'
              ? toolStateService.updateToolPartWithToolCall({
                  part: {
                    ...resume.part,
                    state: {
                      completedAt: now,
                      errorText: 'Approval rejected by user',
                      input: resume.part.state.input,
                      payload: { ok: false, rejected: true },
                      reason: 'execution_denied',
                      status: 'error'
                    }
                  },
                  toolCall: {
                    completedAt: now,
                    errorText: 'Approval rejected by user',
                    id: resume.part.toolCallId,
                    result: { ok: false, rejected: true },
                    status: 'failed',
                    updatedAt: now
                  }
                })
              : null;

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

          if (input.decision === 'rejected') {
            sessionEventService.append({
              messageId: rejectedToolUpdate!.part.messageId,
              part: rejectedToolUpdate!.part,
              runId,
              sessionId: approval.sessionId,
              type: 'message.part.updated'
            });
            sessionEventService.append({
              error: 'Approval rejected by user',
              runId,
              sessionId: approval.sessionId,
              toolCallId: resume.part.toolCallId,
              type: 'tool.failed'
            });
          }

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
              ...(input.decision === 'approved' ? { part: resume.part } : {}),
              runId,
              toolCall: rejectedToolUpdate?.toolCall ?? toolCall
            },
            runId
          };
        });
      },
      async (ctx, signal) => {
        if (input.decision === 'rejected') {
          await this.runtimeLifecycle.startPromptRun({
            runId: ctx.runId,
            sessionId: approval.sessionId,
            signal
          });
          return;
        }

        if (!('part' in ctx)) {
          throw new ServiceError(
            'Approval part is missing for approved tool.',
            500
          );
        }

        await this.runtimeLifecycle.continueApprovalRun({
          approvalPayload: ctx.approval.payload,
          decision: input.decision,
          part: ctx.part,
          runId: ctx.runId,
          sessionId: approval.sessionId,
          signal
        });
      }
    );

    return response;
  }
}

export const sessionInteractionService = new SessionInteractionService();
