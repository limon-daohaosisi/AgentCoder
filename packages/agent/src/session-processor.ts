import { randomUUID } from 'node:crypto';
import type {
  ApprovalDto,
  CreateMessagePartInput,
  MessageDto,
  MessagePart,
  SessionCheckpoint,
  SessionEvent,
  TokenUsageDto,
  ToolCallDto
} from '@opencode/shared';
import type { FinishReason, LanguageModelUsage, TextStreamPart } from 'ai';
import { buildSessionCheckpoint } from './checkpoint.js';
import type { AiSdkTurnRequest } from './context/schema.js';
import type { StreamModelResponse } from './model-client.js';
import {
  prepareToolExecution,
  resolveToolApprovalMode
} from './tool-executor.js';
import type { ToolName } from './tools/types.js';

type CreateApprovalInput = {
  createdAt: string;
  decisionReasonText: null | string;
  decidedAt: null | string;
  decidedBy: null | string;
  decisionScope: 'once' | 'session_rule';
  id: string;
  kind: ApprovalDto['kind'];
  payload: Record<string, unknown>;
  runId?: null | string;
  sessionId: string;
  status: ApprovalDto['status'];
  suggestedRuleJson: null | string;
  taskId: null | string;
  toolCallId: string;
};

type CreateMessagePartWithRunInput = CreateMessagePartInput & {
  runId?: string;
};

type CreateMessageInput = {
  agentName?: string;
  content?: CreateMessagePartInput[];
  createdAt?: string;
  id?: string;
  model?: { modelId: string; providerId: string };
  role: MessageDto['role'];
  runId?: string;
  sessionId: string;
  status?: MessageDto['status'];
  summary?: boolean;
  taskId?: string;
};

type UpdateMessageRuntimeInput = {
  errorText?: null | string;
  finishReason?: null | string;
  id: string;
  modelResponseId?: null | string;
  providerMetadata?: null | Record<string, unknown>;
  status?: MessageDto['status'];
  tokenUsage?: null | TokenUsageDto;
};

export type SessionProcessorDeps = {
  appendMessagePart(input: CreateMessagePartWithRunInput): MessagePart;
  appendSessionEvent(event: SessionEvent): unknown;
  createId?: () => string;
  createMessage(input: CreateMessageInput): MessageDto;
  getCurrentTaskContext?(sessionId: string): {
    currentPlanId?: string;
    currentTaskId?: string;
  };
  createToolPartWithToolCall(input: {
    part: Extract<MessagePart, { type: 'tool' }>;
    toolCall: {
      createdAt: string;
      id: string;
      input: Record<string, unknown>;
      messageId: null | string;
      messagePartId: string;
      modelToolCallId: string;
      providerMetadata?: Record<string, unknown>;
      requiresApproval: boolean;
      runId?: null | string;
      sessionId: string;
      startedAt?: string;
      status: ToolCallDto['status'];
      taskId: null | string;
      toolName: ToolName;
      updatedAt: string;
    };
  }): {
    part: Extract<MessagePart, { type: 'tool' }>;
    toolCall: ToolCallDto;
  };
  now?: () => string;
  persist?<T>(callback: () => T): T;
  prepareToolExecution?: typeof prepareToolExecution;
  resolveToolApprovalMode?: typeof resolveToolApprovalMode;
  streamModelResponse: StreamModelResponse;
  updateMessageRuntime(input: UpdateMessageRuntimeInput): MessageDto | null;
  updateMessagePart(part: MessagePart): MessagePart | null;
  updateToolPartWithToolCall(input: {
    part: Extract<MessagePart, { type: 'tool' }>;
    toolCall: {
      completedAt?: null | string;
      errorText?: null | string;
      id: string;
      result?: null | Record<string, unknown>;
      startedAt?: null | string;
      status: ToolCallDto['status'];
      updatedAt?: string;
    };
  }): {
    part: Extract<MessagePart, { type: 'tool' }>;
    toolCall: ToolCallDto;
  };
};

export type ProcessTurnInput = {
  assistantMessage?: {
    summary?: boolean;
    summarySource?: Extract<MessagePart, { type: 'summary' }>['source'];
  };
  request: AiSdkTurnRequest;
  runId: string;
  signal: AbortSignal;
  sessionId: string;
  workspaceRoot: string;
};

export type ProcessorResult =
  | { finishReason: InternalFinishReason; kind: 'completed' }
  | {
      approval: ApprovalDto;
      checkpoint: SessionCheckpoint;
      kind: 'paused_for_approval';
      toolCall: ToolCallDto;
    }
  | {
      assistantMessageId: string;
      kind: 'tool_calls';
      toolParts: Extract<MessagePart, { type: 'tool' }>[];
    }
  | { reason: string; kind: 'cancelled' }
  | { error: string; kind: 'failed' };

export type InternalFinishReason =
  | 'cancelled'
  | 'content-filter'
  | 'error'
  | 'length'
  | 'other'
  | 'stop'
  | 'tool-calls'
  | 'unknown';

type AssistantMessageState = {
  message: MessageDto | null;
  nextOrder: number;
  reasoningParts: Map<string, Extract<MessagePart, { type: 'reasoning' }>>;
  textParts: Map<string, Extract<MessagePart, { type: 'summary' | 'text' }>>;
  toolCalls: Map<string, ToolCallDto>;
  toolInputBuffers: Map<string, string>;
  toolParts: Extract<MessagePart, { type: 'tool' }>[];
};

type ApprovalCheckpointResult =
  | {
      approval: ApprovalDto;
      checkpoint: SessionCheckpoint;
      toolCall: ToolCallDto;
    }
  | { status: 'tool_error' };

function isToolErrorApprovalCheckpoint(
  value: ApprovalCheckpointResult
): value is Extract<ApprovalCheckpointResult, { status: 'tool_error' }> {
  return 'status' in value && value.status === 'tool_error';
}

function hasPartRunId(
  part: MessagePart
): part is MessagePart & { runId?: string } {
  return 'runId' in part;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown runtime error.';
}

function isAbortError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || /cancelled|aborted/u.test(error.message))
  );
}

function getAbortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason.message
    : typeof signal.reason === 'string'
      ? signal.reason
      : 'Run cancelled by user';
}

function normalizeFinishReason(
  finishReason: FinishReason | string | undefined
): InternalFinishReason {
  switch (finishReason) {
    case 'stop':
    case 'length':
    case 'tool-calls':
    case 'content-filter':
    case 'error':
    case 'other':
      return finishReason;
    default:
      return 'unknown';
  }
}

function normalizeUsage(
  usage: LanguageModelUsage | undefined
): TokenUsageDto | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    cacheRead: usage.inputTokenDetails.cacheReadTokens,
    cacheWrite: usage.inputTokenDetails.cacheWriteTokens,
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    reasoning: usage.outputTokenDetails.reasoningTokens,
    total: usage.totalTokens
  };
}

function isToolCallEvent(
  event: TextStreamPart<AiSdkTurnRequest['tools']>
): event is Extract<
  TextStreamPart<AiSdkTurnRequest['tools']>,
  { type: 'tool-call' }
> {
  return event.type === 'tool-call';
}

export class SessionProcessor {
  constructor(private readonly deps: SessionProcessorDeps) {}

  async processTurn(input: ProcessTurnInput): Promise<ProcessorResult> {
    if (input.signal.aborted) {
      return { kind: 'cancelled', reason: getAbortReason(input.signal) };
    }

    const state: AssistantMessageState = {
      message: null,
      nextOrder: 0,
      reasoningParts: new Map(),
      textParts: new Map(),
      toolCalls: new Map(),
      toolInputBuffers: new Map(),
      toolParts: []
    };
    const stream = this.deps.streamModelResponse(input.request, {
      signal: input.signal
    });
    let finishReason: InternalFinishReason = 'unknown';
    let providerMetadata: Record<string, unknown> | undefined;
    let tokenUsage: TokenUsageDto | undefined;
    let modelResponseId: string | undefined;

    try {
      for await (const event of stream.fullStream) {
        if (input.signal.aborted) {
          return await this.cancelAssistantMessage(
            input.sessionId,
            state,
            input
          );
        }

        if (event.type === 'text-delta') {
          await this.applyTextDelta(input, state, event.id, event.text);
        } else if (event.type === 'reasoning-delta') {
          await this.applyReasoningDelta(input, state, event.id, event.text);
        } else if (event.type === 'tool-input-delta') {
          state.toolInputBuffers.set(
            event.id,
            `${state.toolInputBuffers.get(event.id) ?? ''}${event.delta}`
          );
        } else if (event.type === 'tool-call') {
          const outcome = await this.persistToolCall(input, state, event);

          if (outcome.kind === 'failed') {
            return await this.failAssistantMessage(
              input.sessionId,
              state,
              new Error(outcome.error)
            );
          }
        } else if (event.type === 'finish-step') {
          finishReason = normalizeFinishReason(event.finishReason);
          providerMetadata = event.providerMetadata as
            | Record<string, unknown>
            | undefined;
          tokenUsage = normalizeUsage(event.usage);
          modelResponseId = event.response.id;
        } else if (event.type === 'finish') {
          finishReason = normalizeFinishReason(event.finishReason);
          tokenUsage = normalizeUsage(event.totalUsage);
        } else if (event.type === 'error') {
          return await this.failAssistantMessage(
            input.sessionId,
            state,
            event.error
          );
        }
      }
    } catch (error) {
      if (input.signal.aborted || isAbortError(error)) {
        return await this.cancelAssistantMessage(input.sessionId, state, input);
      }

      return await this.failAssistantMessage(input.sessionId, state, error);
    }

    if (state.message) {
      this.persist(() => {
        this.deps.updateMessageRuntime({
          finishReason,
          id: state.message!.id,
          modelResponseId,
          providerMetadata,
          status: 'completed',
          tokenUsage
        });
        this.deps.appendSessionEvent({
          messageId: state.message!.id,
          runId: input.runId,
          sessionId: input.sessionId,
          type: 'message.completed'
        });
      });
    }

    if (state.toolParts.length === 0) {
      return {
        finishReason,
        kind: 'completed'
      };
    }

    const approvalParts = state.toolParts.filter((part) => {
      const toolCall = state.toolCalls.get(part.id);
      return toolCall?.requiresApproval === true;
    });
    const [approvalPart] = approvalParts;

    if (approvalParts.length > 1) {
      const error = 'Multiple approval-required tool calls are not supported.';

      this.failToolParts(input.sessionId, state, approvalParts, error);

      return { error, kind: 'failed' };
    }

    if (approvalPart) {
      const toolCall = state.toolCalls.get(approvalPart.id);

      if (!toolCall) {
        return {
          error: `Tool call row not found for part ${approvalPart.id}.`,
          kind: 'failed'
        };
      }

      const checkpoint = await this.createApprovalCheckpoint({
        input,
        part: approvalPart,
        toolCall
      });

      if (isToolErrorApprovalCheckpoint(checkpoint)) {
        return {
          assistantMessageId: state.message?.id ?? '',
          kind: 'tool_calls',
          toolParts: []
        };
      }

      return {
        approval: checkpoint.approval,
        checkpoint: checkpoint.checkpoint,
        kind: 'paused_for_approval',
        toolCall: checkpoint.toolCall
      };
    }

    return {
      assistantMessageId: state.message?.id ?? '',
      kind: 'tool_calls',
      toolParts: state.toolParts
    };
  }

  private appendPartCreatedEvent(input: {
    messageId: string;
    part: MessagePart;
    runId?: string;
    sessionId: string;
  }) {
    this.deps.appendSessionEvent({
      messageId: input.messageId,
      part: input.part,
      runId:
        input.runId ??
        (hasPartRunId(input.part) ? input.part.runId : undefined),
      sessionId: input.sessionId,
      type: 'message.part.created'
    });
  }

  private appendPartDeltaEvent(input: {
    delta: string;
    field: 'reasoning.text' | 'text';
    messageId: string;
    partId: string;
    runId?: string;
    sessionId: string;
  }) {
    this.deps.appendSessionEvent({
      delta: input.delta,
      field: input.field,
      messageId: input.messageId,
      partId: input.partId,
      runId: input.runId,
      sessionId: input.sessionId,
      type: 'message.part.delta'
    });
  }

  private appendPartUpdatedEvent(input: {
    messageId: string;
    part: MessagePart;
    runId?: string;
    sessionId: string;
  }) {
    this.deps.appendSessionEvent({
      messageId: input.messageId,
      part: input.part,
      runId:
        input.runId ??
        (hasPartRunId(input.part) ? input.part.runId : undefined),
      sessionId: input.sessionId,
      type: 'message.part.updated'
    });
  }

  private async applyTextDelta(
    input: Pick<
      ProcessTurnInput,
      'assistantMessage' | 'request' | 'runId' | 'sessionId'
    >,
    state: AssistantMessageState,
    streamPartId: string,
    delta: string
  ) {
    const message = await this.ensureAssistantMessage(
      input.sessionId,
      input.runId,
      state,
      input
    );
    this.persist(() => {
      const existing = state.textParts.get(streamPartId);

      if (!existing) {
        const part = this.deps.appendMessagePart(
          input.assistantMessage?.summarySource
            ? {
                messageId: message.id,
                order: state.nextOrder++,
                runId: input.runId,
                sessionId: input.sessionId,
                source: input.assistantMessage.summarySource,
                text: delta,
                type: 'summary'
              }
            : {
                messageId: message.id,
                order: state.nextOrder++,
                runId: input.runId,
                sessionId: input.sessionId,
                text: delta,
                type: 'text'
              }
        ) as Extract<MessagePart, { type: 'summary' | 'text' }>;

        state.textParts.set(streamPartId, part);
        this.appendPartCreatedEvent({
          messageId: message.id,
          part,
          runId: input.runId,
          sessionId: input.sessionId
        });
      } else {
        const updated = this.deps.updateMessagePart({
          ...existing,
          text: existing.text + delta
        }) as Extract<MessagePart, { type: 'summary' | 'text' }> | null;

        if (updated) {
          state.textParts.set(streamPartId, updated);
          this.appendPartDeltaEvent({
            delta,
            field: 'text',
            messageId: message.id,
            partId: updated.id,
            runId: input.runId,
            sessionId: input.sessionId
          });
        }
      }
    });
  }

  private async applyReasoningDelta(
    input: Pick<ProcessTurnInput, 'runId' | 'sessionId'>,
    state: AssistantMessageState,
    streamPartId: string,
    delta: string
  ) {
    const message = await this.ensureAssistantMessage(
      input.sessionId,
      input.runId,
      state
    );
    const existing = state.reasoningParts.get(streamPartId);

    this.persist(() => {
      if (!existing) {
        const part = this.deps.appendMessagePart({
          messageId: message.id,
          order: state.nextOrder++,
          runId: input.runId,
          sessionId: input.sessionId,
          text: delta,
          type: 'reasoning'
        }) as Extract<MessagePart, { type: 'reasoning' }>;

        state.reasoningParts.set(streamPartId, part);
        this.appendPartCreatedEvent({
          messageId: message.id,
          part,
          runId: input.runId,
          sessionId: input.sessionId
        });
        return;
      }

      const updated = this.deps.updateMessagePart({
        ...existing,
        text: existing.text + delta
      }) as Extract<MessagePart, { type: 'reasoning' }> | null;

      if (updated) {
        state.reasoningParts.set(streamPartId, updated);
        this.appendPartDeltaEvent({
          delta,
          field: 'reasoning.text',
          messageId: message.id,
          partId: updated.id,
          runId: input.runId,
          sessionId: input.sessionId
        });
      }
    });
  }

  private async persistToolCall(
    input: ProcessTurnInput,
    state: AssistantMessageState,
    event: Extract<
      TextStreamPart<AiSdkTurnRequest['tools']>,
      { type: 'tool-call' }
    >
  ): Promise<{ kind: 'ok' } | { error: string; kind: 'failed' }> {
    if (!isToolCallEvent(event)) {
      return { kind: 'ok' };
    }

    const policy = input.request.toolPolicies[event.toolName];

    if (!policy?.enabled) {
      return {
        error: `Tool is not enabled: ${event.toolName}`,
        kind: 'failed'
      };
    }

    if (!event.toolCallId) {
      return {
        error: `Tool call for ${event.toolName} is missing toolCallId.`,
        kind: 'failed'
      };
    }

    const message = await this.ensureAssistantMessage(
      input.sessionId,
      input.runId,
      state,
      input
    );
    const now = this.now();
    const toolCallId = this.createId();
    const partId = this.createId();
    const toolName = event.toolName as ToolName;
    const approvalMode = await this.resolveToolApprovalMode({
      rawInput: event.input as Record<string, unknown>,
      sessionId: input.sessionId,
      toolCallId,
      toolName,
      workspaceRoot: input.workspaceRoot
    });
    const currentTaskId = this.deps.getCurrentTaskContext?.(input.sessionId)?.currentTaskId;
    const toolPart: Extract<MessagePart, { type: 'tool' }> = {
      createdAt: now,
      id: partId,
      messageId: message.id,
      modelToolCallId: event.toolCallId,
      order: state.nextOrder++,
      providerMetadata: event.providerMetadata as
        | Record<string, unknown>
        | undefined,
      sessionId: input.sessionId,
      state: {
        input: event.input as Record<string, unknown>,
        rawInput: state.toolInputBuffers.get(event.toolCallId),
        status: 'pending'
      },
      toolCallId,
      toolName,
      type: 'tool',
      updatedAt: now
    };
    const { part: createdPart, toolCall } = this.persist(() => {
      const created = this.deps.createToolPartWithToolCall({
        part: toolPart,
        toolCall: {
          createdAt: now,
          id: toolCallId,
          input: event.input as Record<string, unknown>,
          messageId: message.id,
          messagePartId: toolPart.id,
          modelToolCallId: event.toolCallId,
          providerMetadata: event.providerMetadata as
            | Record<string, unknown>
            | undefined,
          requiresApproval: approvalMode === 'required',
          runId: input.runId,
          sessionId: input.sessionId,
          status: approvalMode === 'required' ? 'pending_approval' : 'pending',
          taskId: currentTaskId ?? null,
          toolName,
          updatedAt: now
        }
      });

      this.appendPartCreatedEvent({
        messageId: message.id,
        part: created.part,
        runId: input.runId,
        sessionId: input.sessionId
      });

      return created;
    });

    state.toolParts.push(createdPart);
    state.toolCalls.set(createdPart.id, toolCall);

    return { kind: 'ok' };
  }

  private async createApprovalCheckpoint(input: {
    input: ProcessTurnInput;
    part: Extract<MessagePart, { type: 'tool' }>;
    toolCall: ToolCallDto;
  }): Promise<ApprovalCheckpointResult> {
    let approvalPayload: Awaited<
      ReturnType<SessionProcessor['prepareToolExecution']>
    >;

    try {
      approvalPayload = await this.prepareToolExecution({
        rawInput: input.part.state.input,
        sessionId: input.input.sessionId,
        toolCallId: input.part.toolCallId,
        toolName: input.part.toolName as ToolName,
        workspaceRoot: input.input.workspaceRoot
      });
    } catch (error) {
      this.failSingleToolPart({
        errorText: formatError(error),
        part: input.part,
        runId: input.input.runId,
        sessionId: input.input.sessionId
      });

      return { status: 'tool_error' };
    }

    if (approvalPayload.kind !== 'approval') {
      throw new Error('Expected approval payload for approval-required tool.');
    }

    const now = this.now();
    const approval: ApprovalDto = {
      createdAt: now,
      decisionReasonText: undefined,
      decidedAt: undefined,
      decidedBy: undefined,
      decisionScope: 'once',
      id: this.createId(),
      kind: input.part.toolName as ApprovalDto['kind'],
      payload: approvalPayload.payload,
      runId: input.input.runId,
      sessionId: input.input.sessionId,
      status: 'pending',
      suggestedRuleJson: undefined,
      taskId: input.toolCall.taskId,
      toolCallId: input.part.toolCallId
    };
    const checkpoint = buildSessionCheckpoint({
      approvalId: approval.id,
      kind: 'waiting_approval',
      messageId: input.part.messageId,
      modelToolCallId: input.part.modelToolCallId,
      partId: input.part.id,
      taskId: input.toolCall.taskId,
      toolCallId: input.part.toolCallId
    });

    return {
      approval,
      checkpoint,
      toolCall: input.toolCall
    };
  }

  private failSingleToolPart(input: {
    errorText: string;
    part: Extract<MessagePart, { type: 'tool' }>;
    runId?: string;
    sessionId: string;
  }) {
    const completedAt = this.now();
    const payload = { error: input.errorText, ok: false };
    const failedPart: Extract<MessagePart, { type: 'tool' }> = {
      ...input.part,
      state: {
        completedAt,
        errorText: input.errorText,
        input: input.part.state.input,
        payload,
        reason: 'tool_error',
        startedAt:
          input.part.state.status === 'running'
            ? input.part.state.startedAt
            : undefined,
        status: 'error'
      },
      updatedAt: completedAt
    };

    this.persist(() => {
      this.deps.updateToolPartWithToolCall({
        part: failedPart,
        toolCall: {
          completedAt,
          errorText: input.errorText,
          id: input.part.toolCallId,
          result: payload,
          startedAt:
            input.part.state.status === 'running'
              ? input.part.state.startedAt
              : undefined,
          status: 'failed',
          updatedAt: completedAt
        }
      });
      this.appendPartUpdatedEvent({
        messageId: failedPart.messageId,
        part: failedPart,
        runId: input.runId,
        sessionId: input.sessionId
      });
      this.deps.appendSessionEvent({
        error: input.errorText,
        runId: input.runId,
        sessionId: input.sessionId,
        toolCallId: input.part.toolCallId,
        type: 'tool.failed'
      });
    });
  }

  private failToolParts(
    sessionId: string,
    state: AssistantMessageState,
    parts: Extract<MessagePart, { type: 'tool' }>[],
    errorText: string,
    runId?: string
  ) {
    const completedAt = this.now();
    const payload = { error: errorText, ok: false };

    this.persist(() => {
      for (const part of parts) {
        const failedPart: Extract<MessagePart, { type: 'tool' }> = {
          ...part,
          state: {
            completedAt,
            errorText,
            input: part.state.input,
            payload,
            reason: 'interrupted',
            status: 'error'
          }
        };

        this.deps.updateToolPartWithToolCall({
          part: failedPart,
          toolCall: {
            completedAt,
            errorText,
            id: part.toolCallId,
            result: payload,
            status: 'failed',
            updatedAt: completedAt
          }
        });
        this.appendPartUpdatedEvent({
          messageId: failedPart.messageId,
          part: failedPart,
          runId,
          sessionId
        });
        this.deps.appendSessionEvent({
          error: errorText,
          runId,
          sessionId,
          toolCallId: part.toolCallId,
          type: 'tool.failed'
        });
      }

      if (state.message) {
        this.deps.updateMessageRuntime({
          errorText,
          finishReason: 'error',
          id: state.message.id,
          status: 'failed'
        });
      }
    });
  }

  private persist<T>(callback: () => T): T {
    return (this.deps.persist ?? ((run) => run()))(callback);
  }

  private async ensureAssistantMessage(
    sessionId: string,
    runId: string,
    state: AssistantMessageState,
    input?: Partial<Pick<ProcessTurnInput, 'assistantMessage' | 'request'>>
  ) {
    if (state.message) {
      return state.message;
    }

    const message = this.persist(() => {
      const currentTaskId = this.deps.getCurrentTaskContext?.(sessionId)?.currentTaskId;
      const created = this.deps.createMessage({
        content: [],
        model: input?.request
          ? {
              modelId: input.request.modelId,
              providerId: input.request.providerId
            }
          : undefined,
        role: 'assistant',
        runId,
        sessionId,
        status: 'running',
        summary: input?.assistantMessage?.summary,
        taskId: currentTaskId
      });

      this.deps.appendSessionEvent({
        message: created,
        sessionId,
        type: 'message.created'
      });

      return created;
    });

    state.message = message;
    return message;
  }

  private async failAssistantMessage(
    sessionId: string,
    state: AssistantMessageState,
    error: unknown
  ): Promise<ProcessorResult> {
    const errorMessage = formatError(error);

    if (state.message) {
      this.persist(() => {
        this.deps.updateMessageRuntime({
          errorText: errorMessage,
          finishReason: 'error',
          id: state.message!.id,
          status: 'failed'
        });
      });
    }

    return {
      error: errorMessage,
      kind: 'failed'
    };
  }

  private async cancelAssistantMessage(
    sessionId: string,
    state: AssistantMessageState,
    input: Pick<ProcessTurnInput, 'runId' | 'signal'>
  ): Promise<ProcessorResult> {
    const reason = getAbortReason(input.signal);

    if (state.message) {
      this.persist(() => {
        this.deps.updateMessageRuntime({
          errorText: null,
          finishReason: 'cancelled',
          id: state.message!.id,
          status: 'cancelled'
        });
        this.deps.appendSessionEvent({
          messageId: state.message!.id,
          runId: input.runId,
          sessionId,
          type: 'message.cancelled'
        });
      });
    }

    if (state.toolParts.length > 0) {
      this.failToolParts(
        sessionId,
        state,
        state.toolParts,
        reason,
        input.runId
      );
    }

    return { kind: 'cancelled', reason };
  }

  private createId() {
    return this.deps.createId?.() ?? randomUUID();
  }

  private now() {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private prepareToolExecution(input: {
    rawInput: Record<string, unknown>;
    sessionId: string;
    toolCallId: string;
    toolName: ToolName;
    workspaceRoot: string;
  }) {
    return (this.deps.prepareToolExecution ?? prepareToolExecution)(input);
  }

  private resolveToolApprovalMode(input: {
    rawInput: Record<string, unknown>;
    sessionId: string;
    toolCallId: string;
    toolName: ToolName;
    workspaceRoot: string;
  }) {
    return (this.deps.resolveToolApprovalMode ?? resolveToolApprovalMode)(input);
  }
}
