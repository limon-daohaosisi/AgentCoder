import type { LanguageModel, ModelMessage } from 'ai';
import { COMPACTED_TOOL_PLACEHOLDER } from '../session-compaction.js';
import { DEFAULT_TOOL_OUTPUT_POLICY } from '../tools/index.js';
import { truncateText } from '../tools/shared/truncation.js';
import type {
  ToolAttachmentPolicy,
  ToolErrorVisibility,
  ToolJsonFieldSpec,
  ToolOutputPolicy
} from '../tools/types.js';
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

function truncateVisibleText(text: string, maxChars: number) {
  return truncateText(text, maxChars).text;
}

function getNestedValue(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;

  for (const segment of path.split('.')) {
    if (
      typeof current !== 'object' ||
      current === null ||
      Array.isArray(current) ||
      !(segment in current)
    ) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function truncateJsonValue(value: JsonValue, maxChars?: number): JsonValue {
  if (typeof value === 'string' && maxChars !== undefined) {
    return truncateVisibleText(value, maxChars);
  }

  return value;
}

function pickVisiblePayload(input: {
  jsonFields: ToolJsonFieldSpec[];
  payload?: Record<string, unknown>;
}): JsonObject | null {
  if (!input.payload || input.jsonFields.length === 0) {
    return null;
  }

  const visibleEntries = input.jsonFields.flatMap((field) => {
    const rawValue = getNestedValue(input.payload!, field.from);

    if (!isJsonValue(rawValue)) {
      return [];
    }

    return [
      [field.as ?? field.from, truncateJsonValue(rawValue, field.maxChars)]
    ];
  });

  if (visibleEntries.length === 0) {
    return null;
  }

  return Object.fromEntries(visibleEntries);
}

function buildVisibleAttachments(input: {
  attachments: NonNullable<
    Extract<ContextPart, { type: 'tool' }>['attachments']
  >;
  policy?: ToolAttachmentPolicy;
}) {
  if (!input.policy?.visibleToModel) {
    return [];
  }

  const maxAttachments =
    input.policy.maxAttachments ?? input.attachments.length;
  const allowedMimePrefixes = input.policy.allowedMimePrefixes ?? [];

  return input.attachments
    .filter((attachment) => {
      if (allowedMimePrefixes.length === 0) {
        return true;
      }

      return allowedMimePrefixes.some((prefix) =>
        attachment.mime.startsWith(prefix)
      );
    })
    .slice(0, maxAttachments)
    .map((attachment) => ({
      filename: attachment.filename,
      type: 'file-url' as const,
      url: attachment.url
    }));
}

function toErrorOutput(input: {
  errorReason?: Extract<ContextPart, { type: 'tool' }>['errorReason'];
  errorText?: string;
  visibility: ToolErrorVisibility;
}): ToolResultOutput {
  if (
    input.errorReason === 'execution_denied' &&
    input.visibility === 'execution_denied_only'
  ) {
    return {
      reason: input.errorText,
      type: 'execution-denied'
    } satisfies ToolResultOutput;
  }

  return {
    type: 'error-text',
    value: input.errorText ?? 'Tool execution failed.'
  } satisfies ToolResultOutput;
}

function toContentOutput(
  part: Extract<ContextPart, { type: 'tool' }>,
  policy: ToolOutputPolicy
): ToolResultOutput | null {
  const attachments = part.attachments?.length
    ? buildVisibleAttachments({
        attachments: part.attachments,
        policy: policy.attachments
      })
    : [];
  const text =
    policy.text?.visibleToModel !== false && part.outputText !== undefined
      ? truncateVisibleText(
          part.outputText,
          policy.text?.maxChars ?? DEFAULT_TOOL_OUTPUT_POLICY.text!.maxChars
        )
      : undefined;

  if (attachments.length === 0) {
    return null;
  }

  return {
    type: 'content',
    value: [
      ...(text === undefined ? [] : [{ text, type: 'text' as const }]),
      ...attachments
    ]
  };
}

function toToolResultOutput(
  part: Extract<ContextPart, { type: 'tool' }>
): ToolResultOutput {
  const policy = part.outputPolicy ?? DEFAULT_TOOL_OUTPUT_POLICY;

  if (part.compactedAt) {
    return {
      type: 'text',
      value: COMPACTED_TOOL_PLACEHOLDER
    } satisfies ToolResultOutput;
  }

  if (part.errorText !== undefined || part.errorReason !== undefined) {
    return toErrorOutput({
      errorReason: part.errorReason,
      errorText: part.errorText,
      visibility: policy.errors?.visibleToModel ?? 'error_text_only'
    });
  }

  if (policy.mode === 'content') {
    const contentOutput = toContentOutput(part, policy);

    if (contentOutput) {
      return contentOutput;
    }
  }

  if (policy.mode === 'json_fields') {
    const visiblePayload = pickVisiblePayload({
      jsonFields: policy.jsonFields ?? [],
      payload: isJsonRecord(part.payload) ? part.payload : undefined
    });

    if (visiblePayload) {
      return {
        type: 'json',
        value: visiblePayload
      } satisfies ToolResultOutput;
    }
  }

  if (policy.text?.visibleToModel !== false && part.outputText !== undefined) {
    return {
      type: 'text',
      value: truncateVisibleText(
        part.outputText,
        policy.text?.maxChars ?? DEFAULT_TOOL_OUTPUT_POLICY.text!.maxChars
      )
    } satisfies ToolResultOutput;
  }

  return {
    type: 'error-text',
    value: 'Tool produced no model-visible output.'
  } satisfies ToolResultOutput;
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
