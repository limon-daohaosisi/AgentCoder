import type {
  CreateMessagePartInput,
  MessageDto,
  MessagePart,
  SessionEvent,
  TokenUsageDto,
  ToolCallDto
} from '@opencode/shared';
import type { LanguageModelUsage } from 'ai';
import { filterCompacted, type ContextBuilderDeps } from './context/builder.js';
import type {
  AiSdkTurnRequest,
  BuiltContext,
  MessageWithParts
} from './context/schema.js';
import type { ModelFactory } from './context/ai-sdk-request-adapter.js';
import type { StreamModelResponse } from './model-client.js';
import type { ProcessorResult } from './session-processor.js';
import type { FileSnapshotStoreLookup } from './tools/shared/file-snapshot.js';
import { truncateText } from './tools/shared/truncation.js';

export const COMPACTED_TOOL_PLACEHOLDER =
  '[Older tool result compacted. Review the durable transcript or rerun the tool if full details are needed.]';

const SUMMARY_TEXT_PART_MAX_CHARS = 12_000;
const SUMMARY_TOOL_INPUT_MAX_CHARS = 2_000;
const SUMMARY_TOOL_OUTPUT_MAX_CHARS = 12_000;
const MAX_RECOVERED_READS = 3;
const MAX_PTL_RETRIES = 3;
const RECENT_SNAPSHOT_LOOKUP_LIMIT = 50;

type CreateMessageInput = {
  agentName?: string;
  content?: CreateMessagePartInput[];
  createdAt?: string;
  errorText?: string;
  finishReason?: string;
  id?: string;
  model?: { modelId: string; providerId: string };
  parentMessageId?: string;
  providerMetadata?: Record<string, unknown>;
  role: MessageDto['role'];
  runId?: string;
  runtime?: MessageDto['runtime'];
  sessionId: string;
  status?: MessageDto['status'];
  summary?: boolean;
  tokenUsage?: TokenUsageDto;
};

type UpdateToolPartWithToolCallInput = {
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

type UpdateMessagePartInput = MessagePart;

export type CompactionReason = 'budget' | 'manual' | 'overflow';

export type CompactOldToolOutputsResult = {
  changedPartIds: string[];
};

export type RunAutoCompactionResult =
  | {
      kind: 'completed';
      postContextMessageId?: string;
      requestMessageId: string;
      summaryMessageId: string;
    }
  | { error: string; kind: 'blocked' };

export type RunManualCompactionResult =
  | {
      kind: 'completed';
      postContextMessageId?: string;
      requestMessageId: string;
      summaryMessageId: string;
    }
  | { error: string; kind: 'blocked' }
  | { error: string; kind: 'failed' };

export type SessionCompactionDeps = Pick<
  ContextBuilderDeps,
  'getSession' | 'listMessages' | 'repairDanglingToolPart'
> & {
  appendSessionEvent(event: SessionEvent): unknown;
  createMessage(input: CreateMessageInput): MessageDto;
  listRecentFileSnapshots?(input: {
    limit: number;
    sessionId: string;
  }): FileSnapshotStoreLookup[];
  markMessagesCompacted?(input: {
    compactedByMessageId: string;
    messageIds: string[];
  }): void;
  modelFactory: ModelFactory;
  now?(): string;
  processTurn?(input: {
    assistantMessage?: {
      summary?: boolean;
      summarySource?: Extract<MessagePart, { type: 'summary' }>['source'];
    };
    request: AiSdkTurnRequest;
    runId: string;
    signal: AbortSignal;
    sessionId: string;
    workspaceRoot: string;
  }): Promise<ProcessorResult>;
  persist?<T>(callback: () => T): T;
  streamModelResponse: StreamModelResponse;
  updateMessageRuntime?(input: UpdateMessageRuntimeInput): MessageDto | null;
  updateMessagePart?(part: UpdateMessagePartInput): MessagePart | null;
  updateToolPartWithToolCall(input: UpdateToolPartWithToolCallInput): {
    part: Extract<MessagePart, { type: 'tool' }>;
    toolCall: ToolCallDto;
  };
};

type RunCompactionInput = {
  context: BuiltContext;
  reason: CompactionReason;
  runId: string;
  sessionId: string;
  signal: AbortSignal;
  workspaceRoot: string;
};

type SummaryRunResult =
  | {
      messageId: string;
      kind: 'completed';
    }
  | { error: string; kind: 'prompt_too_long' }
  | { error: string; kind: 'tool_call' }
  | { error: string; kind: 'failed' };

type ReadRecovery = {
  filePath: string;
  outputText: string;
  readAt: string;
};

function getSnapshotArtifactId(part: Extract<MessagePart, { type: 'tool' }>) {
  if (part.state.status === 'completed' || part.state.status === 'error') {
    const payloadSnapshotArtifactId = part.state.payload?.snapshotArtifactId;

    if (typeof payloadSnapshotArtifactId === 'string') {
      return payloadSnapshotArtifactId;
    }
  }

  if (
    part.state.status === 'running' ||
    part.state.status === 'completed' ||
    part.state.status === 'error'
  ) {
    const metadataSnapshotArtifactId = part.state.metadata?.snapshotArtifactId;

    if (typeof metadataSnapshotArtifactId === 'string') {
      return metadataSnapshotArtifactId;
    }
  }

  return undefined;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown compaction error.';
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

function isPromptTooLongError(error: string) {
  return /prompt\s+too\s+long|context\s+length|maximum\s+context|context\s+window|too\s+many\s+tokens|reduce\s+the\s+length/iu.test(
    error
  );
}

function safeJson(value: unknown, maxChars: number) {
  return truncateText(JSON.stringify(value, null, 2), maxChars).text;
}

function summarizeToolOutput(text: string, maxChars: number) {
  return truncateText(text, maxChars).text;
}

function formatCompactSummary(text: string) {
  const summaryMatch = text.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/iu);

  if (summaryMatch?.[1]) {
    return summaryMatch[1].trim();
  }

  return text
    .replace(/<analysis>[\s\S]*?<\/analysis>/giu, '')
    .replace(/<summary>|<\/summary>/giu, '')
    .trim();
}

function buildCompactionSystemPrompt(systemText: string) {
  const compactInstruction = [
    'You are compacting the durable transcript so the agent can continue the task.',
    'Do not call tools.',
    'If you need scratch space, keep it brief inside <analysis>. Put the final answer in <summary>.',
    'Preserve only durable, execution-relevant facts needed for continuing the work.',
    'Use these sections in order: Current Objective, Important Constraints, Relevant Files / Areas, Decisions Already Made, Outstanding Work, Tool Findings Worth Preserving, Open Risks / Unknowns.'
  ].join('\n');

  return systemText.length > 0
    ? `${systemText}\n\n${compactInstruction}`
    : compactInstruction;
}

function buildCompactionPrompt(input: {
  preCompactTokenCount: number;
  transcript: string;
}) {
  return [
    'Compact the following transcript into a durable continuation summary.',
    `Pre-compact estimated tokens: ${input.preCompactTokenCount}.`,
    'Preserve the current objective, constraints, key files, already-made decisions, remaining work, and concrete tool findings worth keeping.',
    'Do not include speculative filler or hidden chain-of-thought beyond a short disposable <analysis> block.',
    '',
    '<transcript>',
    input.transcript,
    '</transcript>'
  ].join('\n');
}

function buildPostCompactContextText(input: {
  recoveredReads: ReadRecovery[];
  sessionStartBlocks: string[];
}) {
  const sections: string[] = [];

  if (input.recoveredReads.length > 0) {
    sections.push('Post-compact working set:');

    for (const recovery of input.recoveredReads) {
      sections.push(`Recovered recent read for ${recovery.filePath}:`);
      sections.push(recovery.outputText);
    }
  }

  if (input.sessionStartBlocks.length > 0) {
    sections.push('Session start context:');
    sections.push(...input.sessionStartBlocks);
  }

  return sections.join('\n\n').trim();
}

function buildVisibleTranscript(
  messages: MessageWithParts[],
  omittedReadPaths: Set<string>
) {
  const blocks: string[] = [];

  for (const message of messages) {
    const messageLines: string[] = [
      message.role === 'user' ? 'User message:' : 'Assistant message:'
    ];

    for (const part of [...message.content].sort(
      (left, right) => left.order - right.order
    )) {
      switch (part.type) {
        case 'text':
          if (!part.ignored) {
            messageLines.push(
              truncateText(part.text, SUMMARY_TEXT_PART_MAX_CHARS).text
            );
          }
          break;
        case 'summary':
          messageLines.push(
            truncateText(part.text, SUMMARY_TEXT_PART_MAX_CHARS).text
          );
          break;
        case 'file':
          messageLines.push(
            `[file] ${part.filename ?? part.url} (${part.mime})`
          );
          break;
        case 'tool': {
          const inputText = safeJson(
            part.state.input,
            SUMMARY_TOOL_INPUT_MAX_CHARS
          );
          const toolHeader = `Tool ${part.toolName} input:\n${inputText}`;

          if (part.state.status === 'completed') {
            const readFilePath =
              typeof part.state.payload?.filePath === 'string'
                ? part.state.payload.filePath
                : undefined;

            if (readFilePath && omittedReadPaths.has(readFilePath)) {
              break;
            }

            messageLines.push(toolHeader);
            messageLines.push(
              part.state.compactedAt
                ? COMPACTED_TOOL_PLACEHOLDER
                : summarizeToolOutput(
                    part.state.outputText,
                    SUMMARY_TOOL_OUTPUT_MAX_CHARS
                  )
            );
          } else if (part.state.status === 'error') {
            messageLines.push(toolHeader);
            messageLines.push(
              summarizeToolOutput(
                part.state.errorText,
                SUMMARY_TOOL_OUTPUT_MAX_CHARS
              )
            );
          }

          break;
        }
        case 'reasoning':
        case 'patch':
        case 'compaction':
          break;
      }
    }

    if (messageLines.length > 1) {
      blocks.push(messageLines.join('\n\n'));
    }
  }

  return blocks.join('\n\n---\n\n');
}

function groupMessagesByUserTurn(messages: MessageWithParts[]) {
  const groups: MessageWithParts[][] = [];
  let currentGroup: MessageWithParts[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
      }

      currentGroup = [message];
      continue;
    }

    if (currentGroup.length === 0) {
      currentGroup = [message];
      continue;
    }

    currentGroup.push(message);
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

function getLastAssistantMessageId(messages: MessageWithParts[]) {
  return [...messages].reverse().find((message) => message.role === 'assistant')
    ?.id;
}

function getProtectedUserTurnStartIndex(messages: MessageWithParts[]) {
  const userIndexes = messages.flatMap((message, index) =>
    message.role === 'user' ? [index] : []
  );

  if (userIndexes.length <= 2) {
    return 0;
  }

  return userIndexes[userIndexes.length - 2] ?? 0;
}

function collectRecentReadRecoveries(input: {
  messages: MessageWithParts[];
  recentSnapshots: FileSnapshotStoreLookup[];
}) {
  const latestSnapshotByPath = new Map<string, FileSnapshotStoreLookup>();

  for (const lookup of input.recentSnapshots) {
    if (!latestSnapshotByPath.has(lookup.snapshot.path)) {
      latestSnapshotByPath.set(lookup.snapshot.path, lookup);
    }
  }

  const snapshotPriority = new Map(
    [...latestSnapshotByPath.keys()].map((filePath, index) => [filePath, index])
  );
  const recoveries = new Map<string, ReadRecovery>();

  for (const message of [...input.messages].reverse()) {
    for (const part of [...message.content].reverse()) {
      if (
        part.type !== 'tool' ||
        part.toolName !== 'read' ||
        part.state.status !== 'completed'
      ) {
        continue;
      }

      const filePath =
        typeof part.state.payload?.filePath === 'string'
          ? part.state.payload.filePath
          : undefined;
      const snapshotArtifactId = getSnapshotArtifactId(part);
      const latestSnapshot = filePath
        ? latestSnapshotByPath.get(filePath)
        : undefined;

      if (
        !filePath ||
        recoveries.has(filePath) ||
        !part.state.outputText ||
        part.state.payload?.type !== 'file' ||
        !snapshotArtifactId ||
        !latestSnapshot ||
        latestSnapshot.artifactId !== snapshotArtifactId
      ) {
        continue;
      }

      recoveries.set(filePath, {
        filePath,
        outputText: part.state.outputText,
        readAt: part.state.completedAt
      });
    }
  }

  return [...recoveries.values()]
    .sort((left, right) => {
      const leftPriority =
        snapshotPriority.get(left.filePath) ?? Number.MAX_SAFE_INTEGER;
      const rightPriority =
        snapshotPriority.get(right.filePath) ?? Number.MAX_SAFE_INTEGER;

      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      return right.readAt.localeCompare(left.readAt);
    })
    .slice(0, MAX_RECOVERED_READS);
}

function buildRequestLike(input: {
  compactSystem: string;
  context: BuiltContext;
  modelFactory: ModelFactory;
  transcript: string;
}): AiSdkTurnRequest {
  const model = input.context.lastUser.model;

  return {
    messages: [
      {
        content: [{ text: input.transcript, type: 'text' }],
        role: 'user'
      }
    ],
    model: input.modelFactory(model),
    modelId: model.modelId,
    providerId: model.providerId,
    providerOptions:
      model.providerId === 'openai'
        ? {
            openai: {
              instructions: input.compactSystem,
              systemMessageMode: 'remove'
            }
          }
        : undefined,
    system: input.compactSystem,
    toolExecutionMode: 'manual',
    toolPolicies: {},
    tools: {}
  };
}

export class SessionCompaction {
  constructor(private readonly deps: SessionCompactionDeps) {}

  compactOldToolOutputs(input: {
    runId: string;
    sessionId: string;
  }): CompactOldToolOutputsResult {
    const visibleMessages = filterCompacted(
      this.deps.listMessages(input.sessionId)
    );
    const protectedUserTurnStartIndex =
      getProtectedUserTurnStartIndex(visibleMessages);
    const lastAssistantMessageId = getLastAssistantMessageId(visibleMessages);
    const changedPartIds: string[] = [];
    const compactedAt = this.now();

    this.persist(() => {
      visibleMessages.forEach((message, index) => {
        if (
          index >= protectedUserTurnStartIndex ||
          message.id === lastAssistantMessageId
        ) {
          return;
        }

        for (const part of message.content) {
          if (
            part.type !== 'tool' ||
            part.state.status !== 'completed' ||
            part.state.compactedAt ||
            !part.state.outputText
          ) {
            continue;
          }

          const updatedPart: Extract<MessagePart, { type: 'tool' }> = {
            ...part,
            state: {
              ...part.state,
              compactedAt
            },
            updatedAt: compactedAt
          };

          const { part: persistedPart } = this.deps.updateToolPartWithToolCall({
            part: updatedPart,
            toolCall: {
              completedAt: part.state.completedAt,
              id: part.toolCallId,
              result: part.state.payload,
              startedAt: part.state.startedAt,
              status: 'completed',
              updatedAt: compactedAt
            }
          });

          changedPartIds.push(persistedPart.id);
          this.deps.appendSessionEvent({
            messageId: persistedPart.messageId,
            part: persistedPart,
            runId: input.runId,
            sessionId: input.sessionId,
            type: 'message.part.updated'
          });
        }
      });
    });

    return { changedPartIds };
  }

  async runAutoCompaction(
    input: RunCompactionInput
  ): Promise<RunAutoCompactionResult> {
    const result = await this.runCompaction(input);

    if (result.kind === 'completed') {
      return result;
    }

    return {
      error: result.error,
      kind: result.kind === 'failed' ? 'blocked' : result.kind
    };
  }

  async runManualCompaction(
    input: Omit<RunCompactionInput, 'reason'>
  ): Promise<RunManualCompactionResult> {
    return this.runCompaction({ ...input, reason: 'manual' });
  }

  private async runCompaction(
    input: RunCompactionInput
  ): Promise<RunManualCompactionResult> {
    const sourceMessages = filterCompacted(
      this.deps.listMessages(input.sessionId)
    );

    if (sourceMessages.length === 0) {
      return {
        error: 'No durable transcript is available to compact.',
        kind: 'failed'
      };
    }

    const targetMessageId = sourceMessages.at(-1)?.id;
    const preCompactTokenCount = input.context.estimate.tokens;
    const requestMessage = this.createCompactionRequestMessage({
      context: input.context,
      preCompactTokenCount,
      reason: input.reason,
      runId: input.runId,
      sessionId: input.sessionId,
      targetMessageId
    });
    const recentSnapshots =
      this.deps.listRecentFileSnapshots?.({
        limit: RECENT_SNAPSHOT_LOOKUP_LIMIT,
        sessionId: input.sessionId
      }) ?? [];
    const recoveredReads = collectRecentReadRecoveries({
      messages: sourceMessages,
      recentSnapshots
    });
    const omittedReadPaths = new Set(
      recoveredReads.map((recovery) => recovery.filePath)
    );
    const groups = groupMessagesByUserTurn(sourceMessages);

    if (groups.length === 0) {
      return {
        error: 'No user-turn groups are available to compact.',
        kind: 'failed'
      };
    }

    let retryOffset = 0;
    let summaryResult: SummaryRunResult = {
      error: 'Compact summary failed to start.',
      kind: 'failed'
    };

    while (retryOffset < MAX_PTL_RETRIES) {
      const groupedSlice = groups.slice(retryOffset);

      if (groupedSlice.length === 0) {
        break;
      }

      const compactMessages = groupedSlice.flat();
      const transcript = buildVisibleTranscript(
        compactMessages,
        omittedReadPaths
      );
      const compactRequest = buildRequestLike({
        compactSystem: buildCompactionSystemPrompt(
          input.context.system.map((block) => block.text).join('\n\n')
        ),
        context: input.context,
        modelFactory: this.deps.modelFactory,
        transcript: buildCompactionPrompt({
          preCompactTokenCount,
          transcript
        })
      });

      summaryResult = await this.runSummaryStream({
        context: input.context,
        request: compactRequest,
        runId: input.runId,
        sessionId: input.sessionId,
        signal: input.signal,
        workspaceRoot: input.workspaceRoot
      });

      if (summaryResult.kind !== 'prompt_too_long') {
        break;
      }

      retryOffset += 1;
    }

    if (summaryResult.kind === 'prompt_too_long') {
      return {
        error:
          'Compact prompt stayed too large after exhausting user-turn retries.',
        kind: 'blocked'
      };
    }

    if (summaryResult.kind === 'tool_call') {
      return {
        error: summaryResult.error,
        kind: 'blocked'
      };
    }

    if (summaryResult.kind === 'failed') {
      return {
        error: summaryResult.error,
        kind: 'failed'
      };
    }

    const postContextText = buildPostCompactContextText({
      recoveredReads,
      sessionStartBlocks: this.sessionStartBlocks()
    });
    const summaryMessage = this.finalizeSummaryMessage(
      input.sessionId,
      summaryResult.messageId
    );
    const postContextMessage =
      postContextText.length > 0
        ? this.createPostCompactContextMessage({
            runId: input.runId,
            sessionId: input.sessionId,
            text: postContextText
          })
        : undefined;

    this.persist(() => {
      this.deps.markMessagesCompacted?.({
        compactedByMessageId: summaryMessage.id,
        messageIds: sourceMessages.map((message) => message.id)
      });
    });

    return {
      kind: 'completed',
      postContextMessageId: postContextMessage?.id,
      requestMessageId: requestMessage.id,
      summaryMessageId: summaryMessage.id
    };
  }

  private createCompactionRequestMessage(input: {
    context: BuiltContext;
    preCompactTokenCount: number;
    reason: CompactionReason;
    runId: string;
    sessionId: string;
    targetMessageId?: string;
  }) {
    return this.persist(() => {
      const message = this.deps.createMessage({
        agentName: input.context.lastUser.agentName,
        content: [
          {
            auto: input.reason !== 'manual',
            reason: input.reason,
            targetMessageId: input.targetMessageId,
            type: 'compaction'
          }
        ],
        model: input.context.lastUser.model,
        providerMetadata: {
          compaction: {
            preCompactTokenCount: input.preCompactTokenCount
          }
        },
        role: 'user',
        runId: input.runId,
        runtime: input.context.lastUser.runtime,
        sessionId: input.sessionId,
        status: 'completed'
      });

      this.appendMessageEvents({
        message,
        runId: input.runId,
        sessionId: input.sessionId,
        includeCompleted: false
      });

      return message;
    });
  }

  private createPostCompactContextMessage(input: {
    runId: string;
    sessionId: string;
    text: string;
  }) {
    return this.persist(() => {
      const message = this.deps.createMessage({
        content: [
          {
            metadata: { kind: 'post_compact_context' },
            synthetic: true,
            text: input.text,
            type: 'text'
          }
        ],
        role: 'assistant',
        runId: input.runId,
        sessionId: input.sessionId,
        status: 'completed'
      });

      this.appendMessageEvents({
        message,
        runId: input.runId,
        sessionId: input.sessionId,
        includeCompleted: true
      });

      return message;
    });
  }

  private appendMessageEvents(input: {
    includeCompleted: boolean;
    message: MessageDto;
    runId: string;
    sessionId: string;
  }) {
    this.deps.appendSessionEvent({
      message: input.message,
      sessionId: input.sessionId,
      type: 'message.created'
    });

    for (const part of input.message.content) {
      this.deps.appendSessionEvent({
        messageId: input.message.id,
        part,
        runId: input.runId,
        sessionId: input.sessionId,
        type: 'message.part.created'
      });
    }

    if (input.includeCompleted) {
      this.deps.appendSessionEvent({
        messageId: input.message.id,
        runId: input.runId,
        sessionId: input.sessionId,
        type: 'message.completed'
      });
    }
  }

  private async runSummaryStream(input: {
    context: BuiltContext;
    request: AiSdkTurnRequest;
    runId: string;
    sessionId: string;
    signal: AbortSignal;
    workspaceRoot: string;
  }): Promise<SummaryRunResult> {
    if (this.deps.processTurn) {
      const processorResult = await this.deps.processTurn({
        assistantMessage: {
          summary: true,
          summarySource: 'compaction'
        },
        request: input.request,
        runId: input.runId,
        sessionId: input.sessionId,
        signal: input.signal,
        workspaceRoot: input.workspaceRoot
      });

      if (processorResult.kind === 'completed') {
        const summaryMessage = this.findLatestCompactionSummaryMessage(
          input.sessionId,
          input.runId
        );

        if (!summaryMessage) {
          return {
            error: 'Compaction summary message was not persisted.',
            kind: 'failed'
          };
        }

        return {
          kind: 'completed',
          messageId: summaryMessage.id
        };
      }

      if (processorResult.kind === 'tool_calls') {
        return {
          error: 'Compact summary attempted to call a tool.',
          kind: 'tool_call'
        };
      }

      if (processorResult.kind === 'cancelled') {
        return {
          error: processorResult.reason,
          kind: 'failed'
        };
      }

      if (processorResult.kind === 'failed') {
        return isPromptTooLongError(processorResult.error)
          ? { error: processorResult.error, kind: 'prompt_too_long' }
          : { error: processorResult.error, kind: 'failed' };
      }

      return {
        error: 'Compaction summary processor returned an unsupported result.',
        kind: 'failed'
      };
    }

    let text = '';

    try {
      const stream = this.deps.streamModelResponse(input.request, {
        signal: input.signal
      });

      for await (const event of stream.fullStream) {
        if (event.type === 'text-delta') {
          text += event.text;
          continue;
        }

        if (event.type === 'tool-call') {
          return {
            error: 'Compact summary attempted to call a tool.',
            kind: 'tool_call'
          };
        }

        if (event.type === 'finish-step') {
          continue;
        }

        if (event.type === 'finish') {
          continue;
        }

        if (event.type === 'error') {
          const errorText = formatError(event.error);

          return isPromptTooLongError(errorText)
            ? { error: errorText, kind: 'prompt_too_long' }
            : { error: errorText, kind: 'failed' };
        }
      }
    } catch (error) {
      const errorText = formatError(error);

      return isPromptTooLongError(errorText)
        ? { error: errorText, kind: 'prompt_too_long' }
        : { error: errorText, kind: 'failed' };
    }

    const createdMessage = this.persist(() => {
      const message = this.deps.createMessage({
        agentName: input.context.lastUser.agentName,
        content: [
          {
            source: 'compaction',
            text,
            type: 'summary'
          }
        ],
        model: input.context.lastUser.model,
        role: 'assistant',
        runId: input.runId,
        sessionId: input.sessionId,
        status: 'completed',
        summary: true
      });

      this.appendMessageEvents({
        message,
        runId: input.runId,
        sessionId: input.sessionId,
        includeCompleted: true
      });

      return message;
    });

    return {
      kind: 'completed',
      messageId: createdMessage.id
    };
  }

  private finalizeSummaryMessage(sessionId: string, messageId: string) {
    const summaryMessage = this.findMessageById(sessionId, messageId);

    if (!summaryMessage) {
      throw new Error(
        'Compaction summary message not found after persistence.'
      );
    }

    const summaryPart = [...summaryMessage.content]
      .sort((left, right) => left.order - right.order)
      .find((part): part is Extract<MessagePart, { type: 'summary' }> => {
        return part.type === 'summary' && part.source === 'compaction';
      });

    if (!summaryPart) {
      throw new Error('Compaction summary part not found after persistence.');
    }

    const formatted = formatCompactSummary(summaryPart.text);

    if (formatted.length === 0) {
      throw new Error('Compact summary output was empty after formatting.');
    }

    const updatedPart = this.deps.updateMessagePart?.({
      ...summaryPart,
      text: formatted
    });

    if (updatedPart) {
      this.deps.appendSessionEvent({
        messageId: summaryMessage.id,
        part: updatedPart,
        runId: summaryMessage.runId,
        sessionId: summaryMessage.sessionId,
        type: 'message.part.updated'
      });
    }

    const refreshed = this.findMessageById(sessionId, messageId);

    if (!refreshed) {
      throw new Error(
        'Compaction summary message disappeared after formatting.'
      );
    }

    return refreshed;
  }

  private findLatestCompactionSummaryMessage(sessionId: string, runId: string) {
    return [...this.deps.listMessages(sessionId)]
      .reverse()
      .find(
        (message) =>
          message.role === 'assistant' &&
          message.runId === runId &&
          message.summary === true &&
          message.content.some(
            (part) => part.type === 'summary' && part.source === 'compaction'
          )
      );
  }

  private findMessageById(sessionId: string, messageId: string) {
    return this.deps
      .listMessages(sessionId)
      .find((message) => message.id === messageId);
  }

  private sessionStartBlocks() {
    return [] as string[];
  }

  private now() {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private persist<T>(callback: () => T): T {
    return (this.deps.persist ?? ((run) => run()))(callback);
  }
}
