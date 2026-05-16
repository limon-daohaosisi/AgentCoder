import type { SessionVariant } from '@opencode/shared';

export { SYSTEM_PROMPT } from './prompt/core-sections.js';

export type PromptInput = {
  agentName?: string;
  content: string;
  format?:
    | { type: 'text' }
    | { schema: Record<string, unknown>; type: 'json_schema' };
  messageId?: string;
  model?: {
    modelId: string;
    providerId: string;
  };
  sessionId: string;
  system?: string;
  tools?: Record<string, boolean>;
  variant?: SessionVariant;
};

export function normalizePrompt(input: PromptInput) {
  return {
    message: {
      agentName: input.agentName ?? 'default',
      id: input.messageId,
      model:
        input.model ??
        ({
          modelId: process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini',
          providerId: 'openai'
        } as const),
      role: 'user' as const,
      runtime: {
        format: input.format ?? { type: 'text' as const },
        toolOverrides: input.tools,
        userSystem: input.system,
        variant: input.variant
      },
      sessionId: input.sessionId,
      status: 'completed' as const
    },
    parts: [
      {
        text: input.content,
        type: 'text' as const
      }
    ]
  };
}
