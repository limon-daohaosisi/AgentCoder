import type {
  ApprovalDto,
  MessagePart,
  PlanExitApprovalPayload,
  SessionVariant,
  SubmitSessionMessageResponse,
  ToolCallDto
} from '@opencode/shared';
import { Database } from '../../db/runtime.js';
import {
  normalizePrompt,
  ContextBuilder,
  type Lifecycle,
  type SessionCompaction
} from '@opencode/agent';
import { approvalRepository } from '../../repositories/approval-repository.js';
import { toolCallRepository } from '../../repositories/tool-call-repository.js';
import { workspaceRepository } from '../../repositories/workspace-repository.js';
import { ServiceError } from '../../lib/service-error.js';
import {
  buildRunLoopDeps,
  lifecycle,
  sessionCompaction
} from '../../wiring/agent.js';
import { messageService } from '../session/message/service.js';
import type { SessionRunner } from './runner.js';
import { sessionRunner } from './runner.js';
import { sessionService } from '../session/service.js';
import { sessionResumeService } from '../session/resume-service.js';
import { sessionEventService } from '../session-events/event-service.js';
import { agentRunService } from './run-service.js';
import { runtimeContextMessageService } from './runtime-context-message-service.js';
import { toolStateService } from './tool-state-service.js';
import { workspaceSnapshotService } from './workspace-snapshot-service.js';

type ResolveApprovalContext =
  | {
      approval: ApprovalDto;
      part: Extract<MessagePart, { type: 'tool' }>;
      runId: string;
      toolCall: ToolCallDto;
    }
  | {
      approval: ApprovalDto;
      planExitMessage?: ReturnType<typeof messageService.createMessage>;
      runId: string;
      toolCall: ToolCallDto;
    };

type SubmitUserMessageInput = {
  content: string;
  sessionId: string;
  variant?: SessionVariant;
};

function resolveMessageVariant(input: {
  explicitVariant?: SessionVariant;
  sessionDefaultVariant: SessionVariant;
  sessionId: string;
}) {
  if (input.explicitVariant) {
    return input.explicitVariant;
  }

  const lastUserVariant = messageService
    .listMessages(input.sessionId)
    .filter((message) => message.role === 'user')
    .at(-1)?.runtime?.variant;

  return lastUserVariant ?? input.sessionDefaultVariant ?? 'plan';
}

type ManualCompactInput = {
  sessionId: string;
};

export class SessionInteractionService {
  private readonly contextBuilder = new ContextBuilder(buildRunLoopDeps());

  constructor(
    private readonly runner: SessionRunner = sessionRunner,
    private readonly runtimeLifecycle: Lifecycle = lifecycle,
    private readonly runtimeCompaction: SessionCompaction = sessionCompaction
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
        const workspaceRoot = this.resolveWorkspaceRoot(input.sessionId);
        const beforeSnapshotId = await workspaceSnapshotService.track({
          workspaceRoot
        });

        return Database.transaction(() => {
          const revertedSession = session.revert
            ? sessionService.invalidateSessionRevertRestore(input.sessionId)
            : session;
          const run = agentRunService.createRun({ sessionId: input.sessionId });
          const variant = resolveMessageVariant({
            explicitVariant: input.variant,
            sessionDefaultVariant:
              revertedSession?.defaultVariant ?? session.defaultVariant,
            sessionId: input.sessionId
          });

          const normalized = normalizePrompt({
            content: input.content,
            sessionId: input.sessionId,
            variant
          });
          const message = messageService.createMessage({
            ...normalized.message,
            content: normalized.parts,
            runtime: {
              ...normalized.message.runtime,
              beforeSnapshotId
            },
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

  async manualCompact(input: ManualCompactInput) {
    const session = sessionService.getSession(input.sessionId);

    if (!session) {
      throw new ServiceError(`Session not found: ${input.sessionId}`, 404);
    }

    if (
      session.status === 'executing' ||
      session.status === 'waiting_approval'
    ) {
      throw new ServiceError(
        'Session cannot be manually compacted while a run is active.',
        409
      );
    }

    const workspaceRoot = this.resolveWorkspaceRoot(input.sessionId);

    return this.runner.runExclusive(
      input.sessionId,
      async () => {
        const run = Database.transaction(() => {
          const createdRun = agentRunService.createRun({
            sessionId: input.sessionId
          });
          const updatedSession = sessionService.updateSessionRuntimeState({
            lastErrorText: null,
            sessionId: input.sessionId,
            status: 'executing'
          });

          sessionEventService.append({
            run: createdRun,
            sessionId: input.sessionId,
            type: 'run.created'
          });

          if (updatedSession) {
            sessionEventService.append({
              runId: createdRun.id,
              sessionId: updatedSession.id,
              type: 'session.updated',
              updatedAt: updatedSession.updatedAt
            });
          }

          return createdRun;
        });

        return {
          ctx: { run, workspaceRoot },
          runId: run.id
        };
      },
      async (ctx, signal) => {
        try {
          const context = this.contextBuilder.build({
            sessionId: input.sessionId,
            workspaceRoot: ctx.workspaceRoot
          });
          const result = await this.runtimeCompaction.runManualCompaction({
            context,
            runId: ctx.run.id,
            sessionId: input.sessionId,
            signal,
            workspaceRoot: ctx.workspaceRoot
          });

          if (result.kind === 'failed') {
            agentRunService.finalizeRunState({
              errorText: result.error,
              reason: 'failed',
              runId: ctx.run.id,
              sessionId: input.sessionId,
              sessionStatus: 'idle'
            });
            throw new ServiceError(result.error, 500);
          }

          if (result.kind === 'blocked') {
            agentRunService.finalizeRunState({
              errorText: result.error,
              reason: 'blocked',
              runId: ctx.run.id,
              sessionId: input.sessionId,
              sessionStatus: 'blocked'
            });
            throw new ServiceError(result.error, 409);
          }

          agentRunService.finalizeRunState({
            reason: 'completed',
            runId: ctx.run.id,
            sessionId: input.sessionId,
            sessionStatus: 'idle'
          });

          return {
            compacted: true as const,
            postContextMessageId: result.postContextMessageId,
            requestMessageId: result.requestMessageId,
            run: agentRunService.getRun(ctx.run.id) ?? ctx.run,
            summaryMessageId: result.summaryMessageId
          };
        } catch (error) {
          if (!(error instanceof ServiceError)) {
            agentRunService.finalizeRunState({
              errorText:
                error instanceof Error
                  ? error.message
                  : 'Manual compact failed.',
              reason: 'failed',
              runId: ctx.run.id,
              sessionId: input.sessionId,
              sessionStatus: 'idle'
            });
          }

          throw error;
        }
      }
    );
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
          const completedPlanExitUpdate =
            input.decision === 'approved' &&
            updatedApproval.kind === 'plan_exit'
              ? toolStateService.updateToolPartWithToolCall({
                  part: {
                    ...resume.part,
                    state: {
                      completedAt: now,
                      input: resume.part.state.input,
                      metadata: {
                        approvalId: updatedApproval.id,
                        planFilePath: (
                          updatedApproval.payload as PlanExitApprovalPayload
                        ).planFilePath,
                        planId: (
                          updatedApproval.payload as PlanExitApprovalPayload
                        ).planId
                      },
                      outputText:
                        'Plan approved. Exiting planning mode and starting build mode.',
                      payload: { ok: true, planExitApproved: true },
                      startedAt: now,
                      status: 'completed'
                    }
                  },
                  toolCall: {
                    completedAt: now,
                    id: resume.part.toolCallId,
                    result: { ok: true, planExitApproved: true },
                    status: 'completed',
                    updatedAt: now
                  }
                })
              : null;

          const planExitMessage =
            input.decision === 'approved' &&
            updatedApproval.kind === 'plan_exit'
              ? runtimeContextMessageService.persistRuntimeContextMessage({
                  key: `mode_transition:${
                    (updatedApproval.payload as PlanExitApprovalPayload).planId
                  }:${
                    (updatedApproval.payload as PlanExitApprovalPayload)
                      .planFilePath
                  }`,
                  parts: [
                    {
                      kind: 'mode_transition',
                      metadata: {
                        approvalId: updatedApproval.id,
                        planFilePath: (
                          updatedApproval.payload as PlanExitApprovalPayload
                        ).planFilePath,
                        planId: (
                          updatedApproval.payload as PlanExitApprovalPayload
                        ).planId
                      },
                      text: 'The plan has been approved. Begin implementation according to the current plan file and task list.'
                    }
                  ],
                  runId,
                  sessionId: approval.sessionId,
                  variant: 'build'
                })
              : undefined;

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

          if (completedPlanExitUpdate) {
            sessionEventService.append({
              messageId: completedPlanExitUpdate.part.messageId,
              part: completedPlanExitUpdate.part,
              runId,
              sessionId: approval.sessionId,
              type: 'message.part.updated'
            });
            sessionEventService.append({
              runId,
              sessionId: approval.sessionId,
              toolCall: completedPlanExitUpdate.toolCall,
              type: 'tool.completed'
            });
          }

          if (planExitMessage) {
            sessionEventService.append({
              message: planExitMessage,
              sessionId: approval.sessionId,
              type: 'message.created'
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
              ...(planExitMessage ? { planExitMessage } : {}),
              runId,
              toolCall:
                completedPlanExitUpdate?.toolCall ??
                rejectedToolUpdate?.toolCall ??
                toolCall
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

        if (ctx.approval.kind === 'plan_exit') {
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

  private resolveWorkspaceRoot(sessionId: string) {
    const session = sessionService.getSession(sessionId);

    if (!session) {
      throw new ServiceError(`Session not found: ${sessionId}`, 404);
    }

    const workspace = workspaceRepository.getById(session.workspaceId);

    if (!workspace) {
      throw new ServiceError(
        `Workspace not found for session ${sessionId}`,
        404
      );
    }

    return workspace.rootPath;
  }
}

export const sessionInteractionService = new SessionInteractionService();
