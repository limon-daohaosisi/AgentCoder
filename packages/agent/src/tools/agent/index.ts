import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const agentInputSchema = z
  .object({
    description: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    subagentType: z.enum(['explore'])
  })
  .strict();

export const agentToolDefinition: ToolDefinition<
  typeof agentInputSchema,
  {
    childRunId: string;
    ok: true;
    subagentSessionId: string;
    subagentType: 'explore';
    summaryText: string;
    title: string;
  }
> = {
  approval: 'never',
  description:
    'Launch a specialized subagent. Use explore for read-only codebase investigation and return only its concise summary. If you need multiple independent investigations, you may wrap multiple agent tool calls inside a batch so they can run in parallel.',
  async execute({ context, input }) {
    if (!context.services.subagentRun) {
      throw new Error('agent subagent service is not configured.');
    }

    const result = await context.services.subagentRun({
      description: input.description,
      parentSignal: context.abortSignal,
      parentSessionId: context.sessionId,
      parentToolCallId: context.toolCallId,
      prompt: input.prompt,
      subagentType: input.subagentType,
      workspaceRoot: context.workspaceRoot
    });

    return {
      childRunId: result.childRunId,
      ok: true,
      subagentSessionId: result.sessionId,
      subagentType: input.subagentType,
      summaryText: result.summaryText,
      title: result.title
    };
  },
  inputSchema: agentInputSchema,
  isConcurrencySafe: () => true,
  name: 'agent',
  outputPolicy: {
    attachments: { visibleToModel: false },
    errors: { visibleToModel: 'error_text_only' },
    jsonFields: [
      { from: 'subagentType' },
      { from: 'subagentSessionId' },
      { from: 'summaryText', maxChars: 12000 }
    ],
    mode: 'json_fields',
    text: { maxChars: 12000, visibleToModel: true }
  },
  present({ output }) {
    return {
      metadata: {
        childRunId: output.childRunId,
        sessionTitle: output.title,
        subagentSessionId: output.subagentSessionId,
        subagentType: output.subagentType
      },
      outputText: [
        `subagent_session_id: ${output.subagentSessionId}`,
        `subagent_type: ${output.subagentType}`,
        '',
        '<explore_result>',
        output.summaryText,
        '</explore_result>'
      ].join('\n'),
      payload: output
    };
  }
};
