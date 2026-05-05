import type { SessionDto } from '@opencode/shared';
import {
  toAiSdkTurnRequest,
  type ModelFactory
} from './context/ai-sdk-request-adapter.js';
import type { AiSdkTurnRequest } from './context/schema.js';
import { ContextBuilder } from './context/builder.js';
import type { ContextBuilderDeps } from './context/builder.js';
import { ContextSizeGuard } from './context/size-guard.js';
import { resolveTools } from './context/tool-registry.js';
import type { ProcessorResult, SessionProcessor } from './session-processor.js';
import type { ToolExecutor } from './tool-executor.js';

export type RunLoopInput = {
  runId: string;
  signal: AbortSignal;
  sessionId: string;
  workspaceRoot: string;
};

export type RunLoopResult =
  | { finishReason: string; kind: 'completed' }
  | { checkpoint?: unknown; kind: 'paused_for_approval' }
  | { kind: 'cancelled'; reason: string }
  | { error: string; kind: 'failed' }
  | { error: string; kind: 'context_too_large' }
  | { kind: 'max_steps_exceeded' };

const contextTooLargeError = 'context_too_large_compact_not_implemented';

export type RunLoopDeps = ContextBuilderDeps & {
  getSession(sessionId: string): SessionDto | null;
  modelFactory: ModelFactory;
};

export class RunLoop {
  private readonly contextBuilder: ContextBuilder;
  private readonly sizeGuard = new ContextSizeGuard();

  constructor(
    private readonly processor: Pick<SessionProcessor, 'processTurn'>,
    private readonly toolExecutor: Pick<
      ToolExecutor,
      'executePendingToolParts'
    >,
    private readonly deps: RunLoopDeps,
    private readonly maxSteps = 10
  ) {
    this.contextBuilder = new ContextBuilder(deps);
  }

  async run(input: RunLoopInput): Promise<RunLoopResult> {
    for (let step = 0; step < this.maxSteps; step++) {
      if (input.signal.aborted) {
        return { kind: 'cancelled', reason: getAbortReason(input.signal) };
      }

      const session = this.deps.getSession(input.sessionId);

      if (!session) {
        return {
          error: `Session not found: ${input.sessionId}`,
          kind: 'failed'
        };
      }

      if (session.status === 'waiting_approval') {
        return { kind: 'paused_for_approval' };
      }

      let request: AiSdkTurnRequest | null = null;

      try {
        const context = this.contextBuilder.build(input);
        const resolvedTools = resolveTools({
          agentName: context.lastUser.agentName,
          context,
          lastUser: context.lastUser,
          model: context.lastUser.model,
          sessionId: input.sessionId
        });

        request = toAiSdkTurnRequest({
          context,
          modelFactory: this.deps.modelFactory,
          tools: resolvedTools
        });

        this.sizeGuard.assertFits({ context, request, resolvedTools });
      } catch (error) {
        if (error instanceof Error && error.message === contextTooLargeError) {
          return { error: contextTooLargeError, kind: 'context_too_large' };
        }

        throw error;
      }

      if (!request) {
        return { error: 'Failed to build model request.', kind: 'failed' };
      }

      const result = await this.processor.processTurn({
        request,
        runId: input.runId,
        signal: input.signal,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot
      });
      const terminal = await this.handleProcessorResult(input, result);

      if (terminal) {
        return terminal;
      }
    }

    return { kind: 'max_steps_exceeded' };
  }

  private async handleProcessorResult(
    input: RunLoopInput,
    result: ProcessorResult
  ): Promise<RunLoopResult | null> {
    switch (result.kind) {
      case 'completed':
        return { finishReason: result.finishReason, kind: 'completed' };
      case 'paused_for_approval':
        return { checkpoint: result.checkpoint, kind: 'paused_for_approval' };
      case 'failed':
        return { error: result.error, kind: 'failed' };
      case 'cancelled':
        return { kind: 'cancelled', reason: result.reason };
      case 'tool_calls': {
        const toolResult = await this.toolExecutor.executePendingToolParts({
          parts: result.toolParts,
          runId: input.runId,
          signal: input.signal,
          sessionId: input.sessionId,
          workspaceRoot: input.workspaceRoot
        });

        if (toolResult.kind === 'completed') {
          return null;
        }

        if (toolResult.kind === 'paused_for_approval') {
          return {
            checkpoint: toolResult.checkpoint,
            kind: 'paused_for_approval'
          };
        }

        if (toolResult.kind === 'cancelled') {
          return { kind: 'cancelled', reason: toolResult.reason };
        }

        return { error: toolResult.error, kind: 'failed' };
      }
    }
  }
}

function getAbortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason.message
    : typeof signal.reason === 'string'
      ? signal.reason
      : 'Run cancelled by user';
}
