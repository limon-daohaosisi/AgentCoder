import type { LanguageModel, ModelMessage } from 'ai';
import { toAiSdkToolSet, toToolPolicies } from './ai-sdk-tool-adapter.js';
import type {
  AiSdkTurnRequest,
  BuiltContext,
  ContextMessage,
  ContextPart,
  ResolvedTool
} from './schema.js';

export type ModelFactory = (input: {
  modelId: string;
  providerId: string;
}) => LanguageModel;

type ToolResultOutput = Extract<
  Extract<ModelMessage, { role: 'tool' }>['content'][number],
  { type: 'tool-result' }
>['output'];

type JsonValue = boolean | null | number | string | JsonObject | JsonValue[];

type JsonObject = { [key: string]: JsonValue | undefined };

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }

  switch (typeof value) {
    case 'boolean':
    case 'number':
    case 'string':
      return true;
    case 'object':
      if (Array.isArray(value)) {
        return value.every(isJsonValue);
      }

      return Object.values(value as Record<string, unknown>).every(isJsonValue);
    default:
      return false;
  }
}

function isJsonRecord(value: unknown): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    isJsonValue(value)
  );
}

function toContentOutput(
  part: Extract<ContextPart, { type: 'tool' }>
): ToolResultOutput | null {
  if (!part.attachments?.length) {
    return null;
  }

  return {
    type: 'content',
    value: [
      ...(part.outputText === undefined
        ? []
        : [{ text: part.outputText, type: 'text' as const }]),
      ...part.attachments.map((attachment) => ({
        filename: attachment.filename,
        type: 'file-url' as const,
        url: attachment.url
      }))
    ]
  };
}

function toToolResultOutput(
  part: Extract<ContextPart, { type: 'tool' }>
): ToolResultOutput {
  const contentOutput = toContentOutput(part);

  if (contentOutput) {
    return contentOutput;
  }

  if (part.exposePayload && isJsonRecord(part.payload)) {
    const output = {
      type: 'json' as const,
      value: part.payload
    } satisfies ToolResultOutput;

    return output;
  }

  if (part.outputText !== undefined) {
    const output = {
      type: 'text' as const,
      value: part.outputText
    } satisfies ToolResultOutput;

    return output;
  }

  if (part.errorReason === 'execution_denied') {
    const output = {
      reason: part.errorText,
      type: 'execution-denied' as const
    } satisfies ToolResultOutput;

    return output;
  }

  const output = {
    type: 'error-text' as const,
    value: part.errorText ?? 'Tool execution failed.'
  } satisfies ToolResultOutput;

  return output;
}

type UserContent = Extract<ModelMessage, { role: 'user' }>['content'];
type AssistantContent = Extract<ModelMessage, { role: 'assistant' }>['content'];
type ToolContent = Extract<ModelMessage, { role: 'tool' }>['content'];

function toUserContent(parts: ContextPart[]): UserContent {
  const content: Exclude<UserContent, string> = [];

  for (const part of parts) {
    if (part.type === 'text') {
      content.push({ text: part.text, type: 'text' });
    }

    if (part.type === 'file') {
      content.push({
        data: new URL(part.url),
        filename: part.filename,
        mediaType: part.mime,
        type: 'file'
      });
    }
  }

  return content;
}

function toAssistantMessage(message: ContextMessage): ModelMessage[] {
  const assistantContent: Exclude<AssistantContent, string> = [];

  for (const part of message.parts) {
    if (part.type === 'text') {
      assistantContent.push({ text: part.text, type: 'text' });
    }

    if (part.type === 'tool') {
      assistantContent.push({
        input: part.input,
        toolCallId: part.modelToolCallId,
        toolName: part.toolName,
        type: 'tool-call'
      });
    }
  }

  const toolResults: ToolContent = [];

  for (const part of message.parts) {
    if (part.type === 'tool') {
      toolResults.push({
        output: toToolResultOutput(part),
        toolCallId: part.modelToolCallId,
        toolName: part.toolName,
        type: 'tool-result'
      });
    }
  }
  const messages: ModelMessage[] = [];

  if (assistantContent.length > 0) {
    messages.push({
      content: assistantContent,
      role: 'assistant'
    });
  }

  if (toolResults.length > 0) {
    messages.push({
      content: toolResults,
      role: 'tool'
    });
  }

  return messages;
}

export function toAiSdkMessages(context: BuiltContext): ModelMessage[] {
  return context.messages.flatMap((message) => {
    if (message.role === 'user') {
      return [
        {
          content: toUserContent(message.parts),
          role: 'user' as const
        }
      ];
    }

    return toAssistantMessage(message);
  });
}

export function toAiSdkTurnRequest(input: {
  context: BuiltContext;
  modelFactory: ModelFactory;
  tools: ResolvedTool[];
}): AiSdkTurnRequest {
  const model = input.context.lastUser.model;
  const system = input.context.system.map((block) => block.text).join('\n\n');
  const providerOptions =
    model.providerId === 'openai'
      ? {
          openai: {
            instructions: system,
            systemMessageMode: 'remove'
          }
        }
      : undefined;

  return {
    messages: toAiSdkMessages(input.context),
    model: input.modelFactory(model),
    modelId: model.modelId,
    providerId: model.providerId,
    providerOptions,
    system,
    toolExecutionMode: 'manual',
    toolPolicies: toToolPolicies(input.tools),
    tools: toAiSdkToolSet({ executionMode: 'manual', tools: input.tools })
  };
}
