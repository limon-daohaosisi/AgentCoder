import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { PLAN_EXIT_TOOL_PROMPT } from './prompt.js';

export const planExitInputSchema = z
  .object({
    summary: z.string().trim().min(1).optional()
  })
  .strict();

export const planExitToolDefinition: ToolDefinition<
  typeof planExitInputSchema,
  {
    ok: true;
    requested: 'plan_exit';
    summary?: string;
  }
> = {
  approval: 'required',
  async buildApproval({ context, input }) {
    const planContext = context.planContext;

    if (planContext?.variant !== 'plan') {
      throw new Error('plan_exit is only available in plan mode.');
    }

    if (!planContext.filePath) {
      throw new Error('Current plan file path is unavailable.');
    }

    if (!context.services.getSessionPlanApprovalPayload) {
      throw new Error('plan_exit approval payload service is not configured.');
    }

    return context.services.getSessionPlanApprovalPayload({
      sessionId: context.sessionId,
      summary: input.summary
    });
  },
  description: PLAN_EXIT_TOOL_PROMPT,
  async execute({ input }) {
    return {
      ok: true,
      requested: 'plan_exit',
      summary: input.summary
    };
  },
  inputSchema: planExitInputSchema,
  name: 'plan_exit',
  present({ output }) {
    return {
      metadata: {
        requested: output.requested,
        summary: output.summary
      },
      outputText: 'Requested approval to exit planning mode.',
      payload: output
    };
  }
};
