import {
  type MessagePart,
  type SessionCheckpoint,
  type SessionEvent,
  type ToolCallDto,
  type ToolName
} from '@opencode/shared';
import { buildSessionCheckpoint } from './checkpoint.js';
import {
  buildToolExecutionContext,
  type ToolServices,
  type ToolPresentation
} from './tools/core.js';
import { toolByName } from './tools/index.js';

function getAbortReason(signal: AbortSignal | undefined) {
  if (!signal?.aborted) {
    return null;
  }

  return signal.reason instanceof Error
    ? signal.reason.message
    : typeof signal.reason === 'string'
      ? signal.reason
      : 'Run cancelled by user';
}

function formatError(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Unknown tool execution error.';
}

function getToolDefinition(toolName: ToolName) {
  const definition = toolByName[toolName];

  if (!definition) {
    throw new Error(`Unsupported tool: ${toolName}`);
  }

  return definition;
}

type ApprovalResult = {
  kind: 'approval';
  payload: Record<string, unknown>;
};

type AutoExecutionResult = {
  kind: 'auto';
  presentation: ToolPresentation;
};

export type ToolPreparationResult = ApprovalResult | AutoExecutionResult;

export function toolRequiresApproval(toolName: ToolName) {
  return getToolDefinition(toolName).approval === 'required';
}

export async function prepareToolExecution(input: {
  rawInput: Record<string, unknown>;
  services?: ToolServices;
  signal?: AbortSignal;
  toolCallId: string;
  toolName: ToolName;
  sessionId: string;
  workspaceRoot: string;
  now?: () => string;
}): Promise<ToolPreparationResult> {
  const abortReason = getAbortReason(input.signal);

  if (abortReason) {
    throw new Error(abortReason);
  }

  const definition = getToolDefinition(input.toolName);
  const parsedInput = definition.inputSchema.parse(input.rawInput);
  const context = buildToolExecutionContext({
    now: input.now,
    services: input.services,
    sessionId: input.sessionId,
    signal: input.signal,
    toolCallId: input.toolCallId,
    workspaceRoot: input.workspaceRoot
  });

  if (definition.approval === 'required') {
    if (!definition.buildApproval) {
      throw new Error(
        `Approval builder is missing for tool ${input.toolName}.`
      );
    }

    return {
      kind: 'approval',
      payload: await definition.buildApproval({
        context,
        input: parsedInput
      })
    };
  }

  const output = await definition.execute({ context, input: parsedInput });

  return {
    kind: 'auto',
    presentation: definition.present({
      context,
      input: parsedInput,
      output
    })
  };
}

export async function executeApprovedTool(input: {
  approvalPayload?: Record<string, unknown>;
  rawInput: Record<string, unknown>;
  services?: ToolServices;
  signal?: AbortSignal;
  toolCallId: string;
  toolName: ToolName;
  sessionId: string;
  workspaceRoot: string;
  now?: () => string;
}) {
  const abortReason = getAbortReason(input.signal);

  if (abortReason) {
    throw new Error(abortReason);
  }

  const definition = getToolDefinition(input.toolName);

  if (definition.approval !== 'required') {
    throw new Error(`Tool ${input.toolName} does not require approval.`);
  }

  const parsedInput = definition.inputSchema.parse(input.rawInput);
  const context = buildToolExecutionContext({
    now: input.now,
    services: input.services,
    sessionId: input.sessionId,
    signal: input.signal,
    toolCallId: input.toolCallId,
    workspaceRoot: input.workspaceRoot
  });
  const output = await definition.execute({
    approvalPayload: input.approvalPayload,
    context,
    input: parsedInput
  });

  return definition.present({
    context,
    input: parsedInput,
    output
  });
}

export type ToolExecutorDeps = {
  appendSessionEvent(event: SessionEvent): unknown;
  getMessagePart(partId: string): MessagePart | null;
  now?: () => string;
  persist?<T>(callback: () => T): T;
  services?: ToolServices;
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

export type ToolExecutorResult =
  | { executedPartIds: string[]; kind: 'completed' }
  | { checkpoint: SessionCheckpoint; kind: 'paused_for_approval' }
  | { kind: 'cancelled'; reason: string }
  | { error: string; kind: 'failed' };

export class ToolExecutor {
  constructor(private readonly deps: ToolExecutorDeps) {}

  private appendPartUpdatedEvent(input: {
    part: Extract<MessagePart, { type: 'tool' }>;
    runId?: string;
    sessionId: string;
  }) {
    this.deps.appendSessionEvent({
      messageId: input.part.messageId,
      part: input.part,
      runId: input.runId,
      sessionId: input.sessionId,
      type: 'message.part.updated'
    });
  }

  async executePendingToolParts(input: {
    parts: Extract<MessagePart, { type: 'tool' }>[];
    runId: string;
    signal: AbortSignal;
    sessionId: string;
    workspaceRoot: string;
  }): Promise<ToolExecutorResult> {
    const executedPartIds: string[] = [];

    for (const part of input.parts) {
      const abortReason = getAbortReason(input.signal);

      if (abortReason) {
        return { kind: 'cancelled', reason: abortReason };
      }

      if (part.state.status !== 'pending') {
        continue;
      }

      if (toolRequiresApproval(part.toolName as ToolName)) {
        const checkpoint = buildSessionCheckpoint({
          kind: 'waiting_approval',
          messageId: part.messageId,
          modelToolCallId: part.modelToolCallId,
          partId: part.id,
          toolCallId: part.toolCallId
        });

        return { checkpoint, kind: 'paused_for_approval' };
      }

      await this.executePart({
        part,
        runId: input.runId,
        signal: input.signal,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot
      });
      executedPartIds.push(part.id);
    }

    return { executedPartIds, kind: 'completed' };
  }

  async executeApprovedPart(input: {
    approvalPayload?: Record<string, unknown>;
    decision: 'approved' | 'rejected';
    part: Extract<MessagePart, { type: 'tool' }>;
    runId: string;
    signal?: AbortSignal;
    sessionId: string;
    workspaceRoot: string;
  }) {
    if (input.part.state.status !== 'pending') {
      throw new Error('Approval ToolPart is no longer pending.');
    }

    if (input.decision === 'rejected') {
      const completedAt = this.now();
      const rejectedPart: Extract<MessagePart, { type: 'tool' }> = {
        ...input.part,
        state: {
          completedAt,
          errorText: 'Approval rejected by user',
          input: input.part.state.input,
          payload: { ok: false, rejected: true },
          reason: 'execution_denied',
          status: 'error'
        }
      };

      this.persist(() => {
        const { part: updatedPart } = this.deps.updateToolPartWithToolCall({
          part: rejectedPart,
          toolCall: {
            completedAt,
            errorText: 'Approval rejected by user',
            id: input.part.toolCallId,
            result: { ok: false, rejected: true },
            status: 'failed',
            updatedAt: completedAt
          }
        });
        this.appendPartUpdatedEvent({
          part: updatedPart,
          runId: input.runId,
          sessionId: input.sessionId
        });
        this.deps.appendSessionEvent({
          error: 'Approval rejected by user',
          runId: input.runId,
          sessionId: input.sessionId,
          toolCallId: input.part.toolCallId,
          type: 'tool.failed'
        });
      });
      return rejectedPart;
    }

    return this.executePart(input);
  }

  private async executePart(input: {
    approvalPayload?: Record<string, unknown>;
    part: Extract<MessagePart, { type: 'tool' }>;
    runId: string;
    signal?: AbortSignal;
    sessionId: string;
    workspaceRoot: string;
  }) {
    const abortReason = getAbortReason(input.signal);

    if (abortReason) {
      throw new Error(abortReason);
    }

    const startedAt = this.now();
    const runningPart: Extract<MessagePart, { type: 'tool' }> = {
      ...input.part,
      state: {
        input: input.part.state.input,
        metadata:
          input.part.state.status === 'pending'
            ? undefined
            : input.part.state.metadata,
        startedAt,
        status: 'running'
      }
    };

    this.persist(() => {
      const { part: updatedPart } = this.deps.updateToolPartWithToolCall({
        part: runningPart,
        toolCall: {
          id: input.part.toolCallId,
          startedAt,
          status: 'running',
          updatedAt: startedAt
        }
      });
      this.appendPartUpdatedEvent({
        part: updatedPart,
        runId: input.runId,
        sessionId: input.sessionId
      });
      this.deps.appendSessionEvent({
        runId: input.runId,
        sessionId: input.sessionId,
        toolCallId: input.part.toolCallId,
        type: 'tool.running'
      });
    });

    try {
      const presentation = toolRequiresApproval(input.part.toolName as ToolName)
        ? await executeApprovedTool({
            approvalPayload: input.approvalPayload,
            now: this.deps.now,
            rawInput: input.part.state.input,
            services: this.deps.services,
            sessionId: input.sessionId,
            signal: input.signal,
            toolCallId: input.part.toolCallId,
            toolName: input.part.toolName as ToolName,
            workspaceRoot: input.workspaceRoot
          })
        : await (async () => {
            const prepared = await prepareToolExecution({
              now: this.deps.now,
              rawInput: input.part.state.input,
              services: this.deps.services,
              sessionId: input.sessionId,
              signal: input.signal,
              toolCallId: input.part.toolCallId,
              toolName: input.part.toolName as ToolName,
              workspaceRoot: input.workspaceRoot
            });

            if (prepared.kind !== 'auto') {
              throw new Error(
                `Expected auto execution result for tool ${input.part.toolName}.`
              );
            }

            return prepared.presentation;
          })();
      const completedAt = this.now();
      const completedPart: Extract<MessagePart, { type: 'tool' }> = {
        ...runningPart,
        state: {
          attachments: presentation.attachments,
          completedAt,
          input: input.part.state.input,
          metadata: presentation.metadata,
          outputText: presentation.outputText,
          payload: presentation.payload,
          startedAt,
          status: 'completed'
        }
      };

      this.persist(() => {
        const { part: updatedPart, toolCall: completedToolCall } =
          this.deps.updateToolPartWithToolCall({
            part: completedPart,
            toolCall: {
              completedAt,
              id: input.part.toolCallId,
              result: presentation.payload,
              startedAt,
              status: 'completed',
              updatedAt: completedAt
            }
          });

        this.appendPartUpdatedEvent({
          part: updatedPart,
          runId: input.runId,
          sessionId: input.sessionId
        });

        this.deps.appendSessionEvent({
          runId: input.runId,
          sessionId: input.sessionId,
          toolCall: completedToolCall,
          type: 'tool.completed'
        });
      });

      return completedPart;
    } catch (error) {
      const errorText = formatError(error);
      const completedAt = this.now();
      const payload = { error: errorText, ok: false };
      const failedPart: Extract<MessagePart, { type: 'tool' }> = {
        ...runningPart,
        state: {
          completedAt,
          errorText,
          input: input.part.state.input,
          payload,
          reason: getAbortReason(input.signal) ? 'interrupted' : 'tool_error',
          startedAt,
          status: 'error'
        }
      };

      this.persist(() => {
        const { part: updatedPart } = this.deps.updateToolPartWithToolCall({
          part: failedPart,
          toolCall: {
            completedAt,
            errorText,
            id: input.part.toolCallId,
            result: payload,
            startedAt,
            status: 'failed',
            updatedAt: completedAt
          }
        });
        this.appendPartUpdatedEvent({
          part: updatedPart,
          runId: input.runId,
          sessionId: input.sessionId
        });
        this.deps.appendSessionEvent({
          error: errorText,
          runId: input.runId,
          sessionId: input.sessionId,
          toolCallId: input.part.toolCallId,
          type: 'tool.failed'
        });
      });

      return failedPart;
    }
  }

  private persist<T>(callback: () => T): T {
    return (this.deps.persist ?? ((run) => run()))(callback);
  }

  private now() {
    return this.deps.now?.() ?? new Date().toISOString();
  }
}
