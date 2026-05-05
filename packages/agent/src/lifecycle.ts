import type {
  AgentRunDto,
  ApprovalDto,
  MessagePart,
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

export type LifecycleDeps = {
  appendSessionEvent(event: SessionEvent): unknown;
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
  runId: string;
  signal: AbortSignal;
  toolCall: ToolCallDto;
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

      await this.deps.toolExecutor.executeApprovedPart({
        decision: input.decision,
        part: resumeValidation.context.part,
        runId: input.runId,
        signal: input.signal,
        sessionId: input.approval.sessionId,
        workspaceRoot: this.deps.getWorkspaceRootPath(input.approval.sessionId)
      });

      this.deps.updateSessionRuntimeState({
        lastCheckpoint: null,
        lastErrorText: null,
        sessionId: input.approval.sessionId,
        status: 'executing'
      });

      const result = await this.loop.run({
        runId: input.runId,
        signal: input.signal,
        sessionId: input.approval.sessionId,
        workspaceRoot: this.deps.getWorkspaceRootPath(input.approval.sessionId)
      });

      return this.handleResult(input.approval.sessionId, input.runId, result);
    } catch (error) {
      return this.handleFailure(input.approval.sessionId, input.runId, error);
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
        const run = this.deps.markRunCompleted({ runId });
        const updatedSession = this.deps.updateSessionRuntimeState({
          lastCheckpoint: null,
          lastErrorText: null,
          sessionId,
          status: 'idle'
        });

        if (run) {
          this.deps.appendSessionEvent({
            run,
            sessionId,
            type: 'run.completed'
          });
        }

        this.appendSessionUpdated(updatedSession, runId);
        return { reason: result.kind };
      }
      case 'paused_for_approval': {
        const checkpoint =
          typeof result.checkpoint === 'string'
            ? result.checkpoint
            : JSON.stringify(result.checkpoint);
        const run = this.deps.markRunWaitingApproval({
          lastCheckpoint: checkpoint,
          runId
        });
        const updatedSession = this.deps.updateSessionRuntimeState({
          lastCheckpoint: checkpoint,
          lastErrorText: null,
          sessionId,
          status: 'waiting_approval'
        });

        if (run) {
          this.deps.appendSessionEvent({
            checkpoint,
            runId,
            sessionId,
            type: 'session.resumable'
          });
        }

        this.appendSessionUpdated(updatedSession, runId);
        return { reason: result.kind };
      }
      case 'cancelled': {
        const run = this.deps.markRunCancelled({
          errorText: result.reason,
          runId
        });
        const updatedSession = this.deps.updateSessionRuntimeState({
          lastCheckpoint: null,
          lastErrorText: null,
          sessionId,
          status: 'idle'
        });

        if (run) {
          this.deps.appendSessionEvent({
            reason: result.reason,
            run,
            sessionId,
            type: 'run.cancelled'
          });
        }

        this.appendSessionUpdated(updatedSession, runId);
        return { reason: result.kind };
      }
      case 'context_too_large': {
        const run = this.deps.markRunBlocked({
          errorText: result.error,
          runId
        });
        const updatedSession = this.deps.updateSessionRuntimeState({
          lastErrorText: result.error,
          sessionId,
          status: 'blocked'
        });

        if (run) {
          this.deps.appendSessionEvent({
            error: result.error,
            run,
            sessionId,
            type: 'run.failed'
          });
        }

        this.deps.appendSessionEvent({
          error: result.error,
          runId,
          sessionId,
          type: 'session.failed'
        });
        this.appendSessionUpdated(updatedSession, runId);
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
    const run = this.deps.markRunFailed({
      errorText: errorMessage,
      runId
    });
    const updatedSession = this.deps.updateSessionRuntimeState({
      lastErrorText: errorMessage,
      sessionId,
      status: 'failed'
    });

    if (run) {
      this.deps.appendSessionEvent({
        error: errorMessage,
        run,
        sessionId,
        type: 'run.failed'
      });
    }

    this.deps.appendSessionEvent({
      error: errorMessage,
      runId,
      sessionId,
      type: 'session.failed'
    });

    this.appendSessionUpdated(updatedSession, runId);

    return { reason: 'failed' };
  }

  private appendSessionUpdated(
    session: SessionDto | null,
    runId?: string
  ): void {
    if (session) {
      this.deps.appendSessionEvent({
        runId,
        sessionId: session.id,
        type: 'session.updated',
        updatedAt: session.updatedAt
      });
    }
  }
}
