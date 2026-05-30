import type {
  FileAttachment,
  MessageDto,
  MessagePart,
  MessageRuntimeMetadata,
  ToolName
} from '@opencode/shared';
import type { LanguageModel, ModelMessage, ToolSet } from 'ai';
import type { z } from 'zod';
import type { ToolOutputPolicy as AgentToolOutputPolicy } from '../tools/types.js';
import type { CacheDebugInfo } from './cache-debug.js';

export type MessageWithParts = MessageDto & {
  content: MessagePart[];
};

export type ContextSystemBlock = {
  source:
    | 'core'
    | 'format'
    | 'instruction'
    | 'memory'
    | 'mode_rules'
    | 'subagent_rules'
    | 'skill_list'
    | 'user_system';
  text: string;
};

export type ContextLastUser = {
  agentName: string;
  messageId: string;
  model: { modelId: string; providerId: string };
  runtime?: MessageRuntimeMetadata;
};

export type ContextPart =
  | { sourcePartId: string; text: string; type: 'text' }
  | {
      kind:
        | 'environment'
        | 'mode_state'
        | 'mode_transition'
        | 'nested_agents_memory'
        | 'plan_file';
      metadata?: Record<string, unknown>;
      sourcePartId: string;
      text: string;
      type: 'runtime_context';
    }
  | {
      filename?: string;
      mime: string;
      sourcePartId: string;
      type: 'file';
      url: string;
    }
  | {
      attachments?: FileAttachment[];
      compactedAt?: string;
      errorReason?: 'execution_denied' | 'interrupted' | 'tool_error';
      errorText?: string;
      input: Record<string, unknown>;
      modelToolCallId: string;
      outputPolicy?: AgentToolOutputPolicy;
      outputText?: string;
      payload?: Record<string, unknown>;
      sourcePartId: string;
      toolCallId: string;
      toolName: ToolName;
      type: 'tool';
    };

export type ContextMessage = {
  parts: ContextPart[];
  role: 'assistant' | 'user';
  sourceMessageId: string;
};

export type ContextBuildDebug = {
  promptSources: PromptSourceDebug[];
  skippedParts: Array<{
    partId: string;
    reason: string;
  }>;
};

export type PromptSourceDebug = {
  kind: ContextSystemBlock['source'];
  origin?: string;
  sourceId: string;
  truncated?: boolean;
};

export type PromptMemorySource = {
  origin?: string;
  sourceId: string;
  text: string;
  truncated?: boolean;
};

export type RuntimeContextSource = {
  kind:
    | 'environment'
    | 'mode_state'
    | 'mode_transition'
    | 'nested_agents_memory'
    | 'plan_file';
  metadata?: Record<string, unknown>;
  sourceId: string;
  text: string;
};

export type PromptBundle = {
  debugSources: PromptSourceDebug[];
  systemBlocks: ContextSystemBlock[];
};

export type ContextEstimate = {
  chars: number;
  tokens: number;
};

export type BuiltContext = {
  debug: ContextBuildDebug;
  estimate: ContextEstimate;
  lastUser: ContextLastUser;
  messages: ContextMessage[];
  system: ContextSystemBlock[];
};

export type ResolvedTool = {
  approval: 'never' | 'required';
  description: string;
  enabled: boolean;
  inputSchema: z.ZodTypeAny;
  name: string;
  source: 'builtin' | 'mcp' | 'plugin' | 'structured_output';
};

export type ResolvedToolPolicy = {
  approval: ResolvedTool['approval'];
  enabled: boolean;
  name: string;
  source: ResolvedTool['source'];
};

export type ResolvedToolPolicyMap = Record<string, ResolvedToolPolicy>;

export type AiSdkTurnRequest = {
  cacheDebug?: CacheDebugInfo;
  debugRequestKind?: 'compaction' | 'run_loop';
  debugRunId?: string;
  debugSessionId?: string;
  messages: ModelMessage[];
  model: LanguageModel;
  modelId: string;
  providerId: string;
  providerOptions?: Record<string, unknown>;
  system: string;
  toolExecutionMode: 'manual';
  toolPolicies: ResolvedToolPolicyMap;
  tools: ToolSet;
};
