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
import { prepareToolExecution } from './tool-executor.js';
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
  content?: CreateMessagePartInput[];
  createdAt?: string;
  id?: string;
  model?: { modelId: string; providerId: string };
  role: MessageDto['role'];
  runId?: string;
  sessionId: string;
  status?: MessageDto['status'];
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
  createApproval(input: CreateApprovalInput): ApprovalDto;
  createId?: () => string;
  createMessage(input: CreateMessageInput): MessageDto;
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
  prepareToolExecution?: typeof prepareToolExecution;
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
  request: AiSdkTurnRequest;
  runId: string;
  signal: AbortSignal;
  sessionId: string;
  workspaceRoot: string;
};

export type ProcessorResult =
  | { finishReason: InternalFinishReason; kind: 'completed' }
  | {
      assistantMessageId: string;
      kind: 'tool_calls';
      toolParts: Extract<MessagePart, { type: 'tool' }>[];
    }
  | { checkpoint: SessionCheckpoint; kind: 'paused_for_approval' }
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
  textParts: Map<string, Extract<MessagePart, { type: 'text' }>>;
  toolCalls: Map<string, ToolCallDto>;
  toolInputBuffers: Map<string, string>;
  toolParts: Extract<MessagePart, { type: 'tool' }>[];
};

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
            return outcome;
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
      this.deps.updateMessageRuntime({
        finishReason,
        id: state.message.id,
        modelResponseId,
        providerMetadata,
        status: 'completed',
        tokenUsage
      });
      this.deps.appendSessionEvent({
        messageId: state.message.id,
        runId: input.runId,
        sessionId: input.sessionId,
        type: 'message.completed'
      });
    }

    if (state.toolParts.length === 0) {
      return {
        finishReason,
        kind: 'completed'
      };
    }

    const approvalParts = state.toolParts.filter(
      (part) =>
        input.request.toolPolicies[part.toolName]?.approval === 'required'
    );
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

      return {
        checkpoint,
        kind: 'paused_for_approval'
      };
    }

    return {
      assistantMessageId: state.message?.id ?? '',
      kind: 'tool_calls',
      toolParts: state.toolParts
    };
  }

  private async applyTextDelta(
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
    const existing = state.textParts.get(streamPartId);

    if (!existing) {
      const part = this.deps.appendMessagePart({
        messageId: message.id,
        order: state.nextOrder++,
        runId: input.runId,
        sessionId: input.sessionId,
        text: delta,
        type: 'text'
      }) as Extract<MessagePart, { type: 'text' }>;

      state.textParts.set(streamPartId, part);
    } else {
      const updated = this.deps.updateMessagePart({
        ...existing,
        text: existing.text + delta
      }) as Extract<MessagePart, { type: 'text' }> | null;

      if (updated) {
        state.textParts.set(streamPartId, updated);
      }
    }

    this.deps.appendSessionEvent({
      delta,
      messageId: message.id,
      runId: input.runId,
      sessionId: input.sessionId,
      type: 'message.delta'
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
      return;
    }

    const updated = this.deps.updateMessagePart({
      ...existing,
      text: existing.text + delta
    }) as Extract<MessagePart, { type: 'reasoning' }> | null;

    if (updated) {
      state.reasoningParts.set(streamPartId, updated);
    }
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
      state
    );
    const now = this.now();
    const toolCallId = this.createId();
    const partId = this.createId();
    const toolName = event.toolName as ToolName;
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
    const { part: createdPart, toolCall } =
      this.deps.createToolPartWithToolCall({
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
          requiresApproval: policy.approval === 'required',
          runId: input.runId,
          sessionId: input.sessionId,
          status:
            policy.approval === 'required' ? 'pending_approval' : 'pending',
          taskId: null,
          toolName,
          updatedAt: now
        }
      });

    state.toolParts.push(createdPart);
    state.toolCalls.set(createdPart.id, toolCall);

    return { kind: 'ok' };
  }

  private async createApprovalCheckpoint(input: {
    input: ProcessTurnInput;
    part: Extract<MessagePart, { type: 'tool' }>;
    toolCall: ToolCallDto;
  }) {
    const approvalPayload = await this.prepareToolExecution(
      input.part.toolName as ToolName,
      input.part.state.input,
      input.input.workspaceRoot
    );

    if (approvalPayload.kind !== 'approval') {
      throw new Error('Expected approval payload for approval-required tool.');
    }

    const now = this.now();
    const approval = this.deps.createApproval({
      createdAt: now,
      decisionReasonText: null,
      decidedAt: null,
      decidedBy: null,
      decisionScope: 'once',
      id: this.createId(),
      kind: input.part.toolName as ApprovalDto['kind'],
      payload: approvalPayload.payload,
      runId: input.input.runId,
      sessionId: input.input.sessionId,
      status: 'pending',
      suggestedRuleJson: null,
      taskId: null,
      toolCallId: input.part.toolCallId
    });
    const checkpoint = buildSessionCheckpoint({
      approvalId: approval.id,
      kind: 'waiting_approval',
      messageId: input.part.messageId,
      modelToolCallId: input.part.modelToolCallId,
      partId: input.part.id,
      toolCallId: input.part.toolCallId
    });

    this.deps.appendSessionEvent({
      approval,
      runId: input.input.runId,
      sessionId: input.input.sessionId,
      toolCall: input.toolCall,
      type: 'tool.pending'
    });
    this.deps.appendSessionEvent({
      approval,
      runId: input.input.runId,
      sessionId: input.input.sessionId,
      type: 'approval.created'
    });

    return checkpoint;
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
  }

  private async ensureAssistantMessage(
    sessionId: string,
    runId: string,
    state: AssistantMessageState
  ) {
    if (state.message) {
      return state.message;
    }

    const message = this.deps.createMessage({
      content: [],
      role: 'assistant',
      runId,
      sessionId,
      status: 'running'
    });

    state.message = message;
    this.deps.appendSessionEvent({
      message,
      sessionId,
      type: 'message.created'
    });
    return message;
  }

  private async failAssistantMessage(
    sessionId: string,
    state: AssistantMessageState,
    error: unknown
  ): Promise<ProcessorResult> {
    const errorMessage = formatError(error);

    if (state.message) {
      this.deps.updateMessageRuntime({
        errorText: errorMessage,
        finishReason: 'error',
        id: state.message.id,
        status: 'failed'
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
      this.deps.updateMessageRuntime({
        errorText: null,
        finishReason: 'cancelled',
        id: state.message.id,
        status: 'cancelled'
      });
      this.deps.appendSessionEvent({
        messageId: state.message.id,
        runId: input.runId,
        sessionId,
        type: 'message.cancelled'
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

  private prepareToolExecution(
    toolName: ToolName,
    rawInput: Record<string, unknown>,
    workspaceRoot: string
  ) {
    return (this.deps.prepareToolExecution ?? prepareToolExecution)(
      toolName,
      rawInput,
      workspaceRoot
    );
  }
}
