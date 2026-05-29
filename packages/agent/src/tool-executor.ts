import { randomUUID } from 'node:crypto';
import type {
  ApprovalDto,
  MessagePart,
  SessionCheckpoint,
  SessionEvent,
  ToolCallDto,
  ToolName
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

type ApprovalPauseResult = {
  approval: ApprovalDto;
  checkpoint: SessionCheckpoint;
  kind: 'paused_for_approval';
  toolCall: ToolCallDto;
};

type AutoExecutionResult = {
  kind: 'auto';
  presentation: ToolPresentation;
};

type ToolPart = Extract<MessagePart, { type: 'tool' }>;

type BatchExecutionGroup = {
  kind: 'exclusive' | 'parallel';
  parts: ToolPart[];
  remainingParts: ToolPart[];
};

export type ToolPreparationResult = ApprovalResult | AutoExecutionResult;

export function toolRequiresApproval(toolName: ToolName) {
  return getToolDefinition(toolName).approval === 'required';
}

export async function resolveToolApprovalMode(input: {
  rawInput: Record<string, unknown>;
  services?: ToolServices;
  signal?: AbortSignal;
  toolCallId: string;
  toolName: ToolName;
  sessionId: string;
  workspaceRoot: string;
  now?: () => string;
}) {
  const definition = getToolDefinition(input.toolName);
  const parsedInput = definition.inputSchema.parse(input.rawInput);
  const context = await buildToolExecutionContext({
    now: input.now,
    services: input.services,
    sessionId: input.sessionId,
    signal: input.signal,
    toolCallId: input.toolCallId,
    workspaceRoot: input.workspaceRoot
  });

  return definition.resolveApproval
    ? definition.resolveApproval({ context, input: parsedInput })
    : definition.approval;
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
  const context = await buildToolExecutionContext({
    now: input.now,
    services: input.services,
    sessionId: input.sessionId,
    signal: input.signal,
    toolCallId: input.toolCallId,
    workspaceRoot: input.workspaceRoot
  });
  const approvalMode = await resolveToolApprovalMode(input);

  if (approvalMode === 'required') {
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
  const parsedInput = definition.inputSchema.parse(input.rawInput);
  const context = await buildToolExecutionContext({
    now: input.now,
    services: input.services,
    sessionId: input.sessionId,
    signal: input.signal,
    toolCallId: input.toolCallId,
    workspaceRoot: input.workspaceRoot
  });
  const approvalMode = await resolveToolApprovalMode(input);

  if (approvalMode !== 'required') {
    throw new Error(`Tool ${input.toolName} does not require approval.`);
  }

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
  listOpenToolPartsByRun?(runId: string): ToolPart[];
  now?: () => string;
  persist?<T>(callback: () => T): T;
  services?: ToolServices;
  updateToolPartWithToolCall(input: {
    part: ToolPart;
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
    part: ToolPart;
    toolCall: ToolCallDto;
  };
};

export type ToolExecutorResult =
  | { executedPartIds: string[]; kind: 'completed' }
  | ApprovalPauseResult
  | { kind: 'cancelled'; reason: string }
  | { error: string; kind: 'failed' };

export class ToolExecutor {
  constructor(private readonly deps: ToolExecutorDeps) {}

  private appendPartUpdatedEvent(input: {
    part: ToolPart;
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
    parts: ToolPart[];
    runId: string;
    signal: AbortSignal;
    sessionId: string;
    workspaceRoot: string;
  }): Promise<ToolExecutorResult> {
    const executedPartIds: string[] = [];
    const sortedParts = [...input.parts].sort((left, right) =>
      left.order === right.order
        ? left.id.localeCompare(right.id)
        : left.order - right.order
    );
    const standaloneParts = sortedParts.filter((part) => !part.batch);
    const batchPartsById = new Map<string, ToolPart[]>();

    for (const part of sortedParts) {
      if (!part.batch) {
        continue;
      }

      const grouped = batchPartsById.get(part.batch.batchId) ?? [];
      grouped.push(part);
      batchPartsById.set(part.batch.batchId, grouped);
    }

    for (const part of standaloneParts) {
      if (part.state.status !== 'pending') {
        continue;
      }

      const abortReason = getAbortReason(input.signal);

      if (abortReason) {
        return { kind: 'cancelled', reason: abortReason };
      }

      const approvalMode = await resolveToolApprovalMode({
        now: this.deps.now,
        rawInput: part.state.input,
        services: this.deps.services,
        sessionId: input.sessionId,
        signal: input.signal,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        workspaceRoot: input.workspaceRoot
      });

      if (approvalMode === 'required') {
        return this.pauseForApprovalPart({
          part,
          runId: input.runId,
          sessionId: input.sessionId,
          workspaceRoot: input.workspaceRoot
        });
      }

      const completed = await this.executePart({
        part,
        runId: input.runId,
        signal: input.signal,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot
      });

      executedPartIds.push(completed.id);
    }

    for (const [batchId, batchParts] of batchPartsById) {
      const result = await this.executeBatch({
        batchId,
        parts: batchParts,
        runId: input.runId,
        sessionId: input.sessionId,
        signal: input.signal,
        workspaceRoot: input.workspaceRoot
      });

      if (result.kind === 'completed') {
        executedPartIds.push(...result.executedPartIds);
        continue;
      }

      return result;
    }

    return { executedPartIds, kind: 'completed' };
  }

  async executeApprovedPart(input: {
    approvalPayload?: Record<string, unknown>;
    decision: 'approved' | 'rejected';
    part: ToolPart;
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
      const payload = { ok: false, rejected: true };
      const rejectedPart: ToolPart = {
        ...input.part,
        state: {
          completedAt,
          errorText: 'Approval rejected by user',
          input: input.part.state.input,
          payload,
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
            result: payload,
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

  async continueBatch(input: {
    fromPartId: string;
    runId: string;
    sessionId: string;
    signal: AbortSignal;
    workspaceRoot: string;
  }): Promise<ToolExecutorResult> {
    const anchor = this.deps.getMessagePart(input.fromPartId);

    if (!anchor || anchor.type !== 'tool' || !anchor.batch) {
      return { executedPartIds: [], kind: 'completed' };
    }

    const batchParts =
      this.deps
        .listOpenToolPartsByRun?.(input.runId)
        .filter((part) => part.batch?.batchId === anchor.batch!.batchId)
        .filter(
          (part) =>
            part.batch &&
            part.batch.batchIndex > anchor.batch!.batchIndex &&
            part.state.status === 'pending'
        ) ?? [];

    if (batchParts.length === 0) {
      return { executedPartIds: [], kind: 'completed' };
    }

    return this.executeBatch({
      batchId: anchor.batch.batchId,
      parts: batchParts,
      runId: input.runId,
      sessionId: input.sessionId,
      signal: input.signal,
      workspaceRoot: input.workspaceRoot
    });
  }

  private async executePart(input: {
    approvalPayload?: Record<string, unknown>;
    part: ToolPart;
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
    const runningPart: ToolPart = {
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
      const approvalMode = await resolveToolApprovalMode({
        now: this.deps.now,
        rawInput: input.part.state.input,
        services: this.deps.services,
        sessionId: input.sessionId,
        signal: input.signal,
        toolCallId: input.part.toolCallId,
        toolName: input.part.toolName,
        workspaceRoot: input.workspaceRoot
      });
      const presentation =
        approvalMode === 'required'
          ? await executeApprovedTool({
              approvalPayload: input.approvalPayload,
              now: this.deps.now,
              rawInput: input.part.state.input,
              services: this.deps.services,
              sessionId: input.sessionId,
              signal: input.signal,
              toolCallId: input.part.toolCallId,
              toolName: input.part.toolName,
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
                toolName: input.part.toolName,
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
      const completedPart: ToolPart = {
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
      const failedPart: ToolPart = {
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

  private async pauseForApprovalPart(input: {
    part: ToolPart;
    runId: string;
    sessionId: string;
    workspaceRoot: string;
  }): Promise<ApprovalPauseResult | { error: string; kind: 'failed' }> {
    let approvalPayload: ToolPreparationResult;

    try {
      approvalPayload = await prepareToolExecution({
        now: this.deps.now,
        rawInput: input.part.state.input,
        services: this.deps.services,
        sessionId: input.sessionId,
        toolCallId: input.part.toolCallId,
        toolName: input.part.toolName,
        workspaceRoot: input.workspaceRoot
      });
    } catch (error) {
      const errorText = formatError(error);
      const completedAt = this.now();
      const payload = { error: errorText, ok: false };
      const failedPart: ToolPart = {
        ...input.part,
        state: {
          completedAt,
          errorText,
          input: input.part.state.input,
          payload,
          reason: 'tool_error',
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

      return { error: errorText, kind: 'failed' };
    }

    if (approvalPayload.kind !== 'approval') {
      return {
        error: `Expected approval payload for tool ${input.part.toolName}.`,
        kind: 'failed'
      };
    }

    const now = this.now();
    const { toolCall } = this.persist(() =>
      this.deps.updateToolPartWithToolCall({
        part: input.part,
        toolCall: {
          id: input.part.toolCallId,
          status: 'pending_approval',
          updatedAt: now
        }
      })
    );
    const approval: ApprovalDto = {
      createdAt: now,
      id: randomUUID(),
      kind: input.part.toolName as ApprovalDto['kind'],
      payload: approvalPayload.payload,
      runId: input.runId,
      sessionId: input.sessionId,
      status: 'pending',
      taskId: toolCall.taskId,
      toolCallId: input.part.toolCallId
    };
    const checkpoint = buildSessionCheckpoint({
      approvalId: approval.id,
      kind: 'waiting_approval',
      messageId: input.part.messageId,
      modelToolCallId: input.part.modelToolCallId,
      partId: input.part.id,
      taskId: toolCall.taskId,
      toolCallId: input.part.toolCallId
    });

    return {
      approval,
      checkpoint,
      kind: 'paused_for_approval',
      toolCall
    };
  }

  private async executeBatch(input: {
    batchId: string;
    parts: ToolPart[];
    runId: string;
    sessionId: string;
    signal: AbortSignal;
    workspaceRoot: string;
  }): Promise<ToolExecutorResult> {
    const executedPartIds: string[] = [];
    const groups = this.buildBatchExecutionPlan(input.parts);

    for (const group of groups) {
      const abortReason = getAbortReason(input.signal);

      if (abortReason) {
        this.failPendingBatchChildren(group.remainingParts, abortReason, input);
        return { kind: 'cancelled', reason: abortReason };
      }

      if (group.kind === 'parallel') {
        const settled = await Promise.all(
          group.parts.map((part) =>
            this.executePart({
              part,
              runId: input.runId,
              signal: input.signal,
              sessionId: input.sessionId,
              workspaceRoot: input.workspaceRoot
            })
          )
        );
        const failed = settled.find((part) => part.state.status === 'error');

        executedPartIds.push(...settled.map((part) => part.id));

        if (failed?.state.status === 'error') {
          this.failPendingBatchChildren(
            group.remainingParts,
            failed.state.errorText,
            input
          );
          return { executedPartIds, kind: 'completed' };
        }

        continue;
      }

      const [part] = group.parts;

      if (!part) {
        continue;
      }

      const approvalMode = await resolveToolApprovalMode({
        now: this.deps.now,
        rawInput: part.state.input,
        services: this.deps.services,
        sessionId: input.sessionId,
        signal: input.signal,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        workspaceRoot: input.workspaceRoot
      });

      if (approvalMode === 'required') {
        const paused = await this.pauseForApprovalPart({
          part,
          runId: input.runId,
          sessionId: input.sessionId,
          workspaceRoot: input.workspaceRoot
        });

        if (paused.kind === 'failed') {
          this.failPendingBatchChildren(
            group.remainingParts,
            paused.error,
            input
          );
          return { executedPartIds, kind: 'completed' };
        }

        return paused;
      }

      const completed = await this.executePart({
        part,
        runId: input.runId,
        signal: input.signal,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot
      });

      executedPartIds.push(completed.id);

      if (completed.state.status === 'error') {
        this.failPendingBatchChildren(
          group.remainingParts,
          completed.state.errorText,
          input
        );
        return { executedPartIds, kind: 'completed' };
      }
    }

    return { executedPartIds, kind: 'completed' };
  }

  private buildBatchExecutionPlan(parts: ToolPart[]): BatchExecutionGroup[] {
    const ordered = [...parts]
      .filter((part) => part.state.status === 'pending')
      .sort((left, right) => {
        const leftIndex = left.batch?.batchIndex ?? left.order;
        const rightIndex = right.batch?.batchIndex ?? right.order;
        return leftIndex === rightIndex
          ? left.id.localeCompare(right.id)
          : leftIndex - rightIndex;
      });
    const groups: BatchExecutionGroup[] = [];

    for (let index = 0; index < ordered.length; index += 1) {
      const part = ordered[index]!;
      const kind = part.batch?.batchGroupKind ?? 'exclusive';
      const current = groups.at(-1);

      if (!current || kind !== 'parallel' || current.kind !== 'parallel') {
        groups.push({
          kind,
          parts: [part],
          remainingParts: ordered.slice(index + 1)
        });
        continue;
      }

      current.parts.push(part);
      current.remainingParts = ordered.slice(index + 1);
    }

    return groups;
  }

  private failPendingBatchChildren(
    parts: ToolPart[],
    errorText: string,
    input: { runId: string; sessionId: string }
  ) {
    for (const part of parts) {
      if (part.state.status !== 'pending') {
        continue;
      }

      const completedAt = this.now();
      const payload = { error: errorText, ok: false };
      const failedPart: ToolPart = {
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

      this.persist(() => {
        const { part: updatedPart } = this.deps.updateToolPartWithToolCall({
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
          part: updatedPart,
          runId: input.runId,
          sessionId: input.sessionId
        });
        this.deps.appendSessionEvent({
          error: errorText,
          runId: input.runId,
          sessionId: input.sessionId,
          toolCallId: part.toolCallId,
          type: 'tool.failed'
        });
      });
    }
  }

  private persist<T>(callback: () => T): T {
    return (this.deps.persist ?? ((run) => run()))(callback);
  }

  private now() {
    return this.deps.now?.() ?? new Date().toISOString();
  }
}
