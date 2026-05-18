import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TASK_STOP_TOOL_PROMPT } from './prompt.js';

export const taskStopInputSchema = z
  .object({
    reason: z.string().trim().min(1),
    summaryText: z.string().trim().min(1).optional(),
    taskId: z.string().trim().min(1)
  })
  .strict();

export const taskStopToolDefinition: ToolDefinition<
  typeof taskStopInputSchema,
  {
    task: Record<string, unknown>;
  }
> = {
  approval: 'never',
  description: TASK_STOP_TOOL_PROMPT,
  inputSchema: taskStopInputSchema,
  name: 'task_stop',
  outputPolicy: {
    attachments: { visibleToModel: false },
    errors: { visibleToModel: 'error_text_only' },
    jsonFields: [{ from: 'task' }],
    mode: 'json_fields',
    text: { maxChars: 8_000, visibleToModel: true }
  },
  async execute({ context, input }) {
    if (!context.services.taskStop) {
      throw new Error('task_stop service is not configured.');
    }

    const task = await context.services.taskStop({
      reason: input.reason,
      sessionId: context.sessionId,
      summaryText: input.summaryText,
      taskId: input.taskId
    });

    return { task };
  },
  present({ output }) {
    return {
      metadata: {
        status: output.task.status,
        taskId: output.task.id,
        title: output.task.title
      },
      outputText: `Stopped task ${String(output.task.id)} and marked it blocked.`,
      payload: output
    };
  }
};
