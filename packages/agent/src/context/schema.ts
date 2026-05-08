import type {
  FileAttachment,
  MessageDto,
  MessagePart,
  MessageRuntimeMetadata
} from '@opencode/shared';
import type { LanguageModel, ModelMessage, ToolSet } from 'ai';

export type MessageWithParts = MessageDto & {
  content: MessagePart[];
};

export type ContextSystemBlock = {
  source:
    | 'core'
    | 'environment'
    | 'format'
    | 'instruction'
    | 'memory'
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
      filename?: string;
      mime: string;
      sourcePartId: string;
      type: 'file';
      url: string;
    }
  | {
      attachments?: FileAttachment[];
      errorReason?: 'execution_denied' | 'interrupted' | 'tool_error';
      errorText?: string;
      exposePayload?: boolean;
      input: Record<string, unknown>;
      modelToolCallId: string;
      outputText?: string;
      payload?: Record<string, unknown>;
      sourcePartId: string;
      toolCallId: string;
      toolName: string;
      type: 'tool';
    };

export type ContextMessage = {
  parts: ContextPart[];
  role: 'assistant' | 'user';
  sourceMessageId: string;
};

export type ContextBuildDebug = {
  skippedParts: Array<{
    partId: string;
    reason: string;
  }>;
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
  inputSchema: Record<string, unknown>;
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
