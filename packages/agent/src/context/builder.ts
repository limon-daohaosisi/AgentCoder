import type { MessageDto, MessagePart, SessionDto } from '@opencode/shared';
import { DEFAULT_TOOL_OUTPUT_POLICY, toolByName } from '../tools/index.js';
import { resolvePromptBundle } from './prompt-bundle.js';
import {
  buildCoreSystemBlock,
  buildEnvironmentSystemBlock,
  buildRuntimeInstructionBlocks
} from './system-context.js';
import type {
  BuiltContext,
  ContextBuildDebug,
  ContextMessage,
  ContextPart,
  MessageWithParts,
  PromptMemorySource
} from './schema.js';

function getPreviousUserRuntime(messages: MessageWithParts[]) {
  const userMessages = messages.filter((message) => message.role === 'user');

  if (userMessages.length < 2) {
    return undefined;
  }

  return userMessages[userMessages.length - 2]?.runtime;
}

export type ContextBuilderDeps = {
  getSession(sessionId: string): SessionDto | null;
  listPromptMemorySources?(input: {
    agentName: string;
    lastUserRuntime?: MessageWithParts['runtime'];
    model: { modelId: string; providerId: string };
    session: SessionDto;
    sessionId: string;
    workspaceRoot: string;
  }): PromptMemorySource[];
  listMessages(sessionId: string): MessageWithParts[];
  repairDanglingToolPart?(input: {
    part: Extract<MessagePart, { type: 'tool' }>;
  }): Extract<MessagePart, { type: 'tool' }> | null;
};

export type ContextBuilderInput = {
  sessionId: string;
  workspaceRoot: string;
};

function isCompactionRequestMessage(message: MessageWithParts) {
  return message.content.some((part) => part.type === 'compaction');
}

function isCompactionSummaryMessage(message: MessageWithParts) {
  return (
    message.role === 'assistant' &&
    message.status === 'completed' &&
    message.summary === true &&
    message.content.some(
      (part) => part.type === 'summary' && part.source === 'compaction'
    )
  );
}

export function filterCompacted(messages: MessageWithParts[]) {
  const latestCompactionRequestIndex = [...messages]
    .map((message, index) => ({ index, message }))
    .reverse()
    .find(({ message }) => isCompactionRequestMessage(message))?.index;

  if (latestCompactionRequestIndex === undefined) {
    return messages;
  }

  const hasSummaryAfterRequest = messages
    .slice(latestCompactionRequestIndex + 1)
    .some((message) => isCompactionSummaryMessage(message));

  if (!hasSummaryAfterRequest) {
    return messages;
  }

  return messages.slice(latestCompactionRequestIndex);
}

export function insertReminders(messages: MessageWithParts[]) {
  return messages;
}

function compareMessages(left: MessageWithParts, right: MessageWithParts) {
  return left.createdAt.localeCompare(right.createdAt);
}

function defaultModel() {
  return {
    modelId: process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini',
    providerId: 'openai'
  };
}

function estimateTokens(chars: number) {
  return Math.ceil(chars / 4);
}

function countContextChars(messages: ContextMessage[], systemText: string) {
  let chars = systemText.length;

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'text') {
        chars += part.text.length;
      } else if (part.type === 'file') {
        chars +=
          part.url.length + part.mime.length + (part.filename?.length ?? 0);
      } else {
        chars += JSON.stringify(part.input).length;
        chars += part.outputText?.length ?? 0;
        chars += part.errorText?.length ?? 0;
      }
    }
  }

  return chars;
}

function isRunnableMessage(message: MessageDto) {
  return message.role === 'user' || message.role === 'assistant';
}

function toCompletedToolContext(
  part: Extract<MessagePart, { type: 'tool' }>
): ContextPart | null {
  if (part.state.status !== 'completed') {
    return null;
  }

  return {
    attachments: part.state.attachments,
    compactedAt: part.state.compactedAt,
    input: part.state.input,
    modelToolCallId: part.modelToolCallId,
    outputPolicy:
      toolByName[part.toolName]?.outputPolicy ?? DEFAULT_TOOL_OUTPUT_POLICY,
    outputText: part.state.outputText,
    payload: part.state.payload,
    sourcePartId: part.id,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    type: 'tool'
  };
}

function toErrorToolContext(
  part: Extract<MessagePart, { type: 'tool' }>
): ContextPart | null {
  if (part.state.status !== 'error') {
    return null;
  }

  return {
    errorReason: part.state.reason,
    errorText: part.state.errorText,
    input: part.state.input,
    modelToolCallId: part.modelToolCallId,
    outputPolicy:
      toolByName[part.toolName]?.outputPolicy ?? DEFAULT_TOOL_OUTPUT_POLICY,
    sourcePartId: part.id,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    type: 'tool'
  };
}

function repairDanglingToolPart(input: {
  part: Extract<MessagePart, { type: 'tool' }>;
  repair?: ContextBuilderDeps['repairDanglingToolPart'];
}) {
  const completedAt = new Date().toISOString();
  const errorText =
    'Tool execution was interrupted before a result was recorded.';
  const repairedPart: Extract<MessagePart, { type: 'tool' }> = {
    ...input.part,
    state: {
      completedAt,
      errorText,
      input: input.part.state.input,
      payload: { error: errorText, ok: false },
      reason: 'interrupted',
      startedAt:
        input.part.state.status === 'running'
          ? input.part.state.startedAt
          : undefined,
      status: 'error'
    },
    updatedAt: completedAt
  };

  return input.repair?.({ part: repairedPart }) ?? repairedPart;
}

function assertCurrentSchema(messages: MessageWithParts[]) {
  for (const message of messages) {
    if (!isRunnableMessage(message)) {
      throw new Error('Session contains incompatible legacy message roles.');
    }
  }
}

function projectPart(
  part: MessagePart,
  debug: ContextBuildDebug,
  input: {
    repairDanglingToolPart?: ContextBuilderDeps['repairDanglingToolPart'];
    sessionStatus: SessionDto['status'];
  }
): ContextPart | null {
  switch (part.type) {
    case 'text':
      if (part.ignored) {
        debug.skippedParts.push({ partId: part.id, reason: 'text_ignored' });
        return null;
      }

      return {
        sourcePartId: part.id,
        text: part.text,
        type: 'text'
      };
    case 'file':
      return {
        filename: part.filename,
        mime: part.mime,
        sourcePartId: part.id,
        type: 'file',
        url: part.url
      };
    case 'tool':
      if (part.state.status === 'completed') {
        return toCompletedToolContext(part);
      }

      if (part.state.status === 'error') {
        return toErrorToolContext(part);
      }

      if (input.sessionStatus !== 'waiting_approval') {
        const repairedPart = repairDanglingToolPart({
          part,
          repair: input.repairDanglingToolPart
        });

        debug.skippedParts.push({
          partId: part.id,
          reason: 'tool_interrupted_repaired'
        });
        return toErrorToolContext(repairedPart);
      }

      debug.skippedParts.push({
        partId: part.id,
        reason: 'tool_waiting_approval'
      });
      return null;
    case 'reasoning':
      debug.skippedParts.push({ partId: part.id, reason: 'reasoning_hidden' });
      return null;
    case 'patch':
      debug.skippedParts.push({ partId: part.id, reason: 'patch_hidden' });
      return null;
    case 'compaction':
      debug.skippedParts.push({ partId: part.id, reason: 'compaction_hidden' });
      return null;
    case 'summary':
      return {
        sourcePartId: part.id,
        text: part.text,
        type: 'text'
      };
  }
}

function projectMessage(
  message: MessageWithParts,
  debug: ContextBuildDebug,
  input: {
    repairDanglingToolPart?: ContextBuilderDeps['repairDanglingToolPart'];
    sessionStatus: SessionDto['status'];
  }
): ContextMessage | null {
  const parts = [...message.content]
    .sort((left, right) =>
      left.order === right.order
        ? left.id.localeCompare(right.id)
        : left.order - right.order
    )
    .map((part) => projectPart(part, debug, input))
    .filter((part): part is ContextPart => Boolean(part));

  if (parts.length === 0) {
    return null;
  }

  return {
    parts,
    role: message.role,
    sourceMessageId: message.id
  };
}

export class ContextBuilder {
  constructor(private readonly deps: ContextBuilderDeps) {}

  build(input: ContextBuilderInput): BuiltContext {
    const session = this.deps.getSession(input.sessionId);

    if (!session) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }

    const storedMessages = insertReminders(
      filterCompacted(this.deps.listMessages(input.sessionId))
    ).sort(compareMessages);

    assertCurrentSchema(storedMessages);

    const lastUserMessage = [...storedMessages]
      .reverse()
      .find((message) => message.role === 'user');

    if (!lastUserMessage) {
      throw new Error('Session has no user message to run.');
    }

    const model = lastUserMessage.model ?? defaultModel();
    const agentName = lastUserMessage.agentName ?? 'default';
    const previousUserRuntime = getPreviousUserRuntime(storedMessages);
    const debug: ContextBuildDebug = { promptSources: [], skippedParts: [] };
    const messages = storedMessages
      .map((message) =>
        projectMessage(message, debug, {
          repairDanglingToolPart: this.deps.repairDanglingToolPart,
          sessionStatus: session.status
        })
      )
      .filter((message): message is ContextMessage => Boolean(message));
    const memorySources =
      this.deps.listPromptMemorySources?.({
        agentName,
        lastUserRuntime: lastUserMessage.runtime,
        model,
        session,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot
      }) ?? [];
    const bundle = resolvePromptBundle({
      coreBlock: buildCoreSystemBlock(),
      environmentBlock: buildEnvironmentSystemBlock({
        agentName,
        model,
        session,
        workspaceRoot: input.workspaceRoot
      }),
      memorySources,
      runtimeInstructionBlocks: buildRuntimeInstructionBlocks({
        lastUserRuntime: lastUserMessage.runtime,
        previousUserRuntime
      })
    });
    const system = bundle.systemBlocks;
    debug.promptSources = bundle.debugSources;
    const systemText = system.map((block) => block.text).join('\n\n');
    const chars = countContextChars(messages, systemText);

    return {
      debug,
      estimate: {
        chars,
        tokens: estimateTokens(chars)
      },
      lastUser: {
        agentName,
        messageId: lastUserMessage.id,
        model,
        runtime: lastUserMessage.runtime
      },
      messages,
      system
    };
  }
}
