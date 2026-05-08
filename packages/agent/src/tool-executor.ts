import {
  type MessagePart,
  type SessionEvent,
  type SessionCheckpoint,
  type ToolCallDto
} from '@opencode/shared';
import { buildSessionCheckpoint } from './checkpoint.js';
import {
  buildWriteFileApproval,
  executeWriteFile,
  type ReadFileToolInput,
  readFileInputSchema,
  readFileTool,
  runCommandInputSchema,
  runCommandTool,
  type RunCommandToolInput,
  type WriteFileToolInput,
  writeFileInputSchema
} from './tools/index.js';
import type { ToolName } from './tools/types.js';

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

type ApprovalResult = {
  kind: 'approval';
  payload: Record<string, unknown>;
};

type AutoExecutionResult = {
  kind: 'auto';
  output: Record<string, unknown>;
};

type ParsedToolInput =
  | {
      input: ReadFileToolInput;
      toolName: 'read_file';
    }
  | {
      input: WriteFileToolInput;
      toolName: 'write_file';
    }
  | {
      input: RunCommandToolInput;
      toolName: 'run_command';
    };

export type ToolPreparationResult = ApprovalResult | AutoExecutionResult;

function parseToolInput(
  toolName: ToolName,
  input: Record<string, unknown>
): ParsedToolInput {
  switch (toolName) {
    case 'read_file':
      return {
        input: readFileInputSchema.parse(input),
        toolName
      };
    case 'write_file':
      return {
        input: writeFileInputSchema.parse(input),
        toolName
      };
    case 'run_command':
      return {
        input: runCommandInputSchema.parse(input),
        toolName
      };
  }
}

export function toolRequiresApproval(toolName: ToolName) {
  return toolName === 'write_file' || toolName === 'run_command';
}

export async function prepareToolExecution(
  toolName: ToolName,
  rawInput: Record<string, unknown>,
  workspaceRoot: string,
  options: { signal?: AbortSignal } = {}
): Promise<ToolPreparationResult> {
  const abortReason = getAbortReason(options.signal);

  if (abortReason) {
    throw new Error(abortReason);
  }

  const parsed = parseToolInput(toolName, rawInput);

  switch (parsed.toolName) {
    case 'read_file':
      return {
        kind: 'auto',
        output: await readFileTool(parsed.input, workspaceRoot, options)
      };
    case 'write_file':
      return {
        kind: 'approval',
        payload: await buildWriteFileApproval(parsed.input, workspaceRoot)
      };
    case 'run_command':
      return {
        kind: 'approval',
        payload: {
          command: parsed.input.command,
          summary: 'Run non-interactive shell command after approval.',
          timeoutMs: parsed.input.timeoutMs
        }
      };
  }
}

export async function executeApprovedTool(
  toolName: Extract<ToolName, 'run_command' | 'write_file'>,
  rawInput: Record<string, unknown>,
  workspaceRoot: string,
  options: { signal?: AbortSignal } = {}
) {
  const abortReason = getAbortReason(options.signal);

  if (abortReason) {
    throw new Error(abortReason);
  }

  const parsed = parseToolInput(toolName, rawInput);

  switch (parsed.toolName) {
    case 'write_file':
      return executeWriteFile(parsed.input, workspaceRoot, options);
    case 'run_command':
      return runCommandTool(parsed.input, workspaceRoot, options);
  }

  throw new Error(`Unsupported approval tool: ${toolName}`);
}

export type ToolExecutorDeps = {
  appendSessionEvent(event: SessionEvent): unknown;
  getMessagePart(partId: string): MessagePart | null;
  now?: () => string;
  persist?<T>(callback: () => T): T;
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

function formatToolOutput(toolName: ToolName, output: Record<string, unknown>) {
  if (toolName === 'read_file' && typeof output.content === 'string') {
    return output.content;
  }

  if (toolName === 'write_file') {
    return `Updated ${String(output.path ?? 'file')} successfully.`;
  }

  if (toolName === 'run_command') {
    const stdout = typeof output.stdout === 'string' ? output.stdout : '';
    const stderr = typeof output.stderr === 'string' ? output.stderr : '';
    const exitCode = output.exitCode;
    return [`Exit code: ${String(exitCode ?? 'null')}`, stdout, stderr]
      .filter(Boolean)
      .join('\n');
  }

  return JSON.stringify(output);
}

function formatError(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Unknown tool execution error.';
}

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
      const prepared = await prepareToolExecution(
        input.part.toolName as ToolName,
        input.part.state.input,
        input.workspaceRoot,
        { signal: input.signal }
      );
      const output =
        prepared.kind === 'auto'
          ? prepared.output
          : await executeApprovedTool(
              input.part.toolName as Extract<
                ToolName,
                'run_command' | 'write_file'
              >,
              input.part.state.input,
              input.workspaceRoot,
              { signal: input.signal }
            );
      const completedAt = this.now();
      const completedPart: Extract<MessagePart, { type: 'tool' }> = {
        ...runningPart,
        state: {
          completedAt,
          input: input.part.state.input,
          outputText: formatToolOutput(input.part.toolName as ToolName, output),
          payload: output,
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
              result: output,
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
