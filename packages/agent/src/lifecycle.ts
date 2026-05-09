import type {
  AgentRunDto,
  ApprovalDto,
  MessagePart,
  SessionCheckpoint,
  SessionDto,
  SessionEvent,
  SessionStatus,
  ToolCallDto
} from '@opencode/shared';
import { validateApprovalResume } from './approval-resume.js';
import { parseSessionCheckpoint } from './checkpoint.js';
import type { RunLoop, RunLoopResult } from './run-loop.js';
import type { ToolExecutor } from './tool-executor.js';

type UpdateSessionRuntimeStateInput = {
  currentTaskId?: null | string;
  lastCheckpoint?: null | string;
  lastErrorText?: null | string;
  sessionId: string;
  status?: SessionStatus;
};

type MarkRunInput = {
  errorText?: null | string;
  runId: string;
};

type FinalizeRunStateInput =
  | {
      checkpoint?: never;
      errorText?: null | string;
      reason: 'blocked' | 'cancelled' | 'completed' | 'failed';
      runId: string;
      sessionId: string;
      sessionStatus: Extract<SessionStatus, 'blocked' | 'idle'>;
    }
  | {
      checkpoint: string;
      errorText?: null | string;
      reason: 'waiting_approval';
      runId: string;
      sessionId: string;
      sessionStatus: 'waiting_approval';
    };

type PauseForApprovalInput = {
  approval: ApprovalDto;
  checkpoint: SessionCheckpoint;
  runId: string;
  sessionId: string;
  toolCall: ToolCallDto;
};

export type LifecycleDeps = {
  appendSessionEvent(event: SessionEvent): unknown;
  finalizeRunState(input: FinalizeRunStateInput): {
    run: AgentRunDto | null;
    session: SessionDto | null;
  };
  getMessagePart(partId: string): MessagePart | null;
  getSession(sessionId: string): SessionDto | null;
  getWorkspaceRootPath(sessionId: string): string;
  markRunBlocked(
    input: MarkRunInput & { errorText: string }
  ): AgentRunDto | null;
  markRunCancelled(input: MarkRunInput): AgentRunDto | null;
  markRunCompleted(input: MarkRunInput): AgentRunDto | null;
  markRunFailed(
    input: MarkRunInput & { errorText: string }
  ): AgentRunDto | null;
  markRunWaitingApproval(
    input: MarkRunInput & { lastCheckpoint: string }
  ): AgentRunDto | null;
  pauseForApproval(input: PauseForApprovalInput): unknown;
  toolExecutor: Pick<ToolExecutor, 'executeApprovedPart'>;
  updateSessionRuntimeState(
    input: UpdateSessionRuntimeStateInput
  ): SessionDto | null;
};

type StartPromptRunInput = {
  runId: string;
  signal: AbortSignal;
  sessionId: string;
};

type ResumeApprovalRunInput = {
  approval: ApprovalDto;
  decision: 'approved' | 'rejected';
  part?: Extract<MessagePart, { type: 'tool' }>;
  runId: string;
  signal: AbortSignal;
  toolCall: ToolCallDto;
};

type ContinueApprovalRunInput = {
  approvalPayload?: Record<string, unknown>;
  decision: 'approved' | 'rejected';
  part: Extract<MessagePart, { type: 'tool' }>;
  runId: string;
  sessionId: string;
  signal: AbortSignal;
};

export type LifecycleTerminalReason = RunLoopResult['kind'] | 'failed';

export type LifecycleResult = {
  reason: LifecycleTerminalReason;
};

function formatError(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown runtime error.';
}

export class Lifecycle {
  constructor(
    private readonly loop: Pick<RunLoop, 'run'>,
    private readonly deps: LifecycleDeps
  ) {}

  async resumeApprovalRun(
    input: ResumeApprovalRunInput
  ): Promise<LifecycleResult> {
    try {
      const part = input.part ?? this.resolveApprovalPart(input);

      return await this.continueApprovalRun({
        approvalPayload: input.approval.payload,
        decision: input.decision,
        part,
        runId: input.runId,
        sessionId: input.approval.sessionId,
        signal: input.signal
      });
    } catch (error) {
      return this.handleFailure(input.approval.sessionId, input.runId, error);
    }
  }

  async continueApprovalRun(
    input: ContinueApprovalRunInput
  ): Promise<LifecycleResult> {
    try {
      await this.deps.toolExecutor.executeApprovedPart({
        approvalPayload: input.approvalPayload,
        decision: input.decision,
        part: input.part,
        runId: input.runId,
        signal: input.signal,
        sessionId: input.sessionId,
        workspaceRoot: this.deps.getWorkspaceRootPath(input.sessionId)
      });

      const result = await this.loop.run({
        runId: input.runId,
        signal: input.signal,
        sessionId: input.sessionId,
        workspaceRoot: this.deps.getWorkspaceRootPath(input.sessionId)
      });

      return this.handleResult(input.sessionId, input.runId, result);
    } catch (error) {
      return this.handleFailure(input.sessionId, input.runId, error);
    }
  }

  async startPromptRun(input: StartPromptRunInput): Promise<LifecycleResult> {
    try {
      const session = this.deps.getSession(input.sessionId);

      if (!session) {
        throw new Error(`Session not found: ${input.sessionId}`);
      }

      const result = await this.loop.run({
        runId: input.runId,
        signal: input.signal,
        sessionId: input.sessionId,
        workspaceRoot: this.deps.getWorkspaceRootPath(input.sessionId)
      });

      return this.handleResult(input.sessionId, input.runId, result);
    } catch (error) {
      return this.handleFailure(input.sessionId, input.runId, error);
    }
  }

  private handleResult(
    sessionId: string,
    runId: string,
    result: RunLoopResult
  ): LifecycleResult {
    switch (result.kind) {
      case 'completed': {
        this.deps.finalizeRunState({
          reason: 'completed',
          runId,
          sessionId,
          sessionStatus: 'idle'
        });
        return { reason: result.kind };
      }
      case 'paused_for_approval': {
        if (!result.checkpoint || !result.approval || !result.toolCall) {
          throw new Error('Approval pause is missing checkpoint state.');
        }

        const checkpoint =
          typeof result.checkpoint === 'string'
            ? result.checkpoint
            : JSON.stringify(result.checkpoint);
        this.deps.pauseForApproval({
          approval: result.approval,
          checkpoint: result.checkpoint,
          runId,
          sessionId,
          toolCall: result.toolCall
        });
        return { reason: result.kind };
      }
      case 'cancelled': {
        this.deps.finalizeRunState({
          errorText: result.reason,
          reason: 'cancelled',
          runId,
          sessionId,
          sessionStatus: 'idle'
        });
        return { reason: result.kind };
      }
      case 'context_too_large': {
        this.deps.finalizeRunState({
          errorText: result.error,
          reason: 'blocked',
          runId,
          sessionId,
          sessionStatus: 'blocked'
        });
        return { reason: result.kind };
      }
      case 'failed':
        return this.handleFailure(sessionId, runId, new Error(result.error));
      case 'max_steps_exceeded':
        return this.handleFailure(
          sessionId,
          runId,
          new Error('Run exceeded maximum steps.')
        );
    }
  }

  private handleFailure(
    sessionId: string,
    runId: string,
    error: unknown
  ): LifecycleResult {
    const errorMessage = formatError(error);
    this.deps.finalizeRunState({
      errorText: errorMessage,
      reason: 'failed',
      runId,
      sessionId,
      sessionStatus: 'idle'
    });

    return { reason: 'failed' };
  }

  private resolveApprovalPart(
    input: ResumeApprovalRunInput
  ): Extract<MessagePart, { type: 'tool' }> {
    const session = this.deps.getSession(input.approval.sessionId);

    if (!session) {
      throw new Error(`Session not found: ${input.approval.sessionId}`);
    }

    const checkpoint = parseSessionCheckpoint(session.lastCheckpointJson);
    const part = checkpoint?.partId
      ? this.deps.getMessagePart(checkpoint.partId)
      : null;
    const resumeValidation = validateApprovalResume({
      approval: input.approval,
      checkpoint,
      part,
      session,
      toolCall: input.toolCall
    });

    if (!resumeValidation.ok) {
      throw new Error(resumeValidation.reason);
    }

    return resumeValidation.context.part;
  }
}
