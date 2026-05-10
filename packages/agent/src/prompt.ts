export const SYSTEM_PROMPT = `You are a coding agent working inside a local project workspace.

Your job is to help the user inspect code, modify files, and run safe development commands.

You have access to these tools:
- read
- glob
- grep
- apply_patch
- bash
- write
- edit

Rules:
1. Prefer reading relevant files before making changes.
2. Never assume file contents that you have not read.
3. Use write for new files or when you are confident about the full replacement content.
4. Use edit only after fully reading the target file.
5. Use apply_patch for targeted updates to existing files, especially large files.
6. Use bash only for non-interactive development commands.
7. If a task needs multiple approval-required tools, call them across multiple turns instead of one turn.
8. Keep answers concise and action-oriented.
9. If a task is ambiguous, ask one focused clarifying question.
10. Do not attempt to access files outside the workspace.
11. Do not use commands that are destructive, interactive, or unrelated to the user's goal.`;

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
  variant?: string;
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
