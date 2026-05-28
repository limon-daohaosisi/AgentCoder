import { createHash } from 'node:crypto';
import type { ModelMessage } from 'ai';
import type { ContextBuildDebug, ResolvedTool } from './schema.js';

type CacheComparableValue =
  | null
  | boolean
  | number
  | string
  | CacheComparableValue[]
  | { [key: string]: CacheComparableValue | undefined };

export type CacheDebugRequestFingerprint = {
  assistantOnlyPrefixHash: string;
  assistantOnlyPrefixLength: number;
  enabledTools: string[];
  lastMessageRole?: ModelMessage['role'];
  messageCount: number;
  messagePrefixHash: string;
  messagePrefixLength: number;
  messageTailHash: string;
  messageTailLength: number;
  modelId: string;
  providerId: string;
  systemHash: string;
  systemLength: number;
  systemSources: string[];
  toolHash: string;
  userOnlyPrefixHash: string;
  userOnlyPrefixLength: number;
};

export type CacheDebugComparison = {
  messagePrefixChanged: boolean;
  systemChanged: boolean;
  toolSchemaChanged: boolean;
};

export type CacheDebugInfo = {
  comparison?: CacheDebugComparison;
  request: CacheDebugRequestFingerprint;
};

function stableSerialize(value: unknown): string {
  return serializeValue(value);
}

function serializeValue(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || value === undefined) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? String(value) : '"[NonFiniteNumber]"';
    case 'string':
      return JSON.stringify(value);
    case 'function':
      return JSON.stringify(`[Function:${value.name || 'anonymous'}]`);
    case 'object':
      if (value instanceof Date) {
        return JSON.stringify(value.toISOString());
      }

      if (value instanceof RegExp) {
        return JSON.stringify(value.toString());
      }

      if (Array.isArray(value)) {
        return `[${value.map((item) => serializeValue(item, seen)).join(',')}]`;
      }

      if (seen.has(value as object)) {
        return JSON.stringify('[Circular]');
      }

      seen.add(value as object);
      const entries = Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(
          ([key, entryValue]) =>
            `${JSON.stringify(key)}:${serializeValue(entryValue, seen)}`
        );
      seen.delete(value as object);
      return `{${entries.join(',')}}`;
    default:
      return JSON.stringify(`[Unsupported:${typeof value}]`);
  }
}

function hashText(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

function countMessageChars(messages: ModelMessage[]) {
  return stableSerialize(messages).length;
}

function filterMessagesByRole(
  messages: ModelMessage[],
  role: ModelMessage['role']
) {
  return messages.filter((message) => message.role === role);
}

function buildToolFingerprintPayload(tools: ResolvedTool[]) {
  return tools.map((tool) => ({
    approval: tool.approval,
    description: tool.description,
    name: tool.name,
    schema: (tool.inputSchema as { _def?: unknown })._def ?? null,
    source: tool.source
  }));
}

export function buildCacheDebugFingerprint(input: {
  model: { modelId: string; providerId: string };
  messages: ModelMessage[];
  system: string;
  tools: ResolvedTool[];
  contextDebug: ContextBuildDebug;
}): CacheDebugRequestFingerprint {
  const lastMessage = input.messages.at(-1);
  const messagePrefix =
    input.messages.length > 0 ? input.messages.slice(0, -1) : input.messages;
  const messageTail = lastMessage ? [lastMessage] : [];
  const userOnlyPrefix = filterMessagesByRole(messagePrefix, 'user');
  const assistantOnlyPrefix = filterMessagesByRole(messagePrefix, 'assistant');
  const toolPayload = buildToolFingerprintPayload(input.tools);

  return {
    assistantOnlyPrefixHash: hashText(stableSerialize(assistantOnlyPrefix)),
    assistantOnlyPrefixLength: countMessageChars(assistantOnlyPrefix),
    enabledTools: input.tools.map((tool) => tool.name),
    lastMessageRole: lastMessage?.role,
    messageCount: input.messages.length,
    messagePrefixHash: hashText(stableSerialize(messagePrefix)),
    messagePrefixLength: countMessageChars(messagePrefix),
    messageTailHash: hashText(stableSerialize(messageTail)),
    messageTailLength: countMessageChars(messageTail),
    modelId: input.model.modelId,
    providerId: input.model.providerId,
    systemHash: hashText(input.system),
    systemLength: input.system.length,
    systemSources: input.contextDebug.promptSources.map(
      (source) => source.kind
    ),
    toolHash: hashText(stableSerialize(toolPayload)),
    userOnlyPrefixHash: hashText(stableSerialize(userOnlyPrefix)),
    userOnlyPrefixLength: countMessageChars(userOnlyPrefix)
  };
}

export function compareCacheDebugFingerprints(input: {
  previous?: CacheDebugRequestFingerprint;
  current: CacheDebugRequestFingerprint;
}): CacheDebugComparison | undefined {
  if (!input.previous) {
    return undefined;
  }

  return {
    messagePrefixChanged:
      input.previous.messagePrefixHash !== input.current.messagePrefixHash,
    systemChanged: input.previous.systemHash !== input.current.systemHash,
    toolSchemaChanged: input.previous.toolHash !== input.current.toolHash
  };
}
