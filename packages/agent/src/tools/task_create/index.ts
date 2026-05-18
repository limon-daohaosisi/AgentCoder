import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TASK_CREATE_TOOL_PROMPT } from './prompt.js';

export const taskCreateInputSchema = z
  .object({
    acceptanceCriteria: z.array(z.string().trim().min(1)).optional(),
    description: z.string().trim().min(1).optional(),
    position: z.number().int().positive().optional(),
    status: z.enum(['todo', 'ready']).optional(),
    title: z.string().trim().min(1)
  })
  .strict();

export const taskCreateToolDefinition: ToolDefinition<
  typeof taskCreateInputSchema,
  {
    task: Record<string, unknown>;
  }
> = {
  approval: 'never',
  description: TASK_CREATE_TOOL_PROMPT,
  inputSchema: taskCreateInputSchema,
  name: 'task_create',
  outputPolicy: {
    attachments: { visibleToModel: false },
    errors: { visibleToModel: 'error_text_only' },
    jsonFields: [{ from: 'task' }],
    mode: 'json_fields',
    text: { maxChars: 8_000, visibleToModel: true }
  },
  async execute({ context, input }) {
    if (!context.services.taskCreate) {
      throw new Error('task_create service is not configured.');
    }

    const task = await context.services.taskCreate({
      acceptanceCriteria: input.acceptanceCriteria,
      description: input.description,
      position: input.position,
      sessionId: context.sessionId,
      status: input.status,
      title: input.title
    });

    return { task };
  },
  present({ output }) {
    return {
      metadata: {
        taskId: output.task.id,
        title: output.task.title
      },
      outputText: `Created task ${String(output.task.id)}: ${String(output.task.title)}`,
      payload: output
    };
  }
};
