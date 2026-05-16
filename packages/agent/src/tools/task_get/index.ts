import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TASK_GET_TOOL_PROMPT } from './prompt.js';

export const taskGetInputSchema = z
  .object({
    taskId: z.string().trim().min(1)
  })
  .strict();

export const taskGetToolDefinition: ToolDefinition<
  typeof taskGetInputSchema,
  {
    task: null | Record<string, unknown>;
  }
> = {
  approval: 'never',
  description: TASK_GET_TOOL_PROMPT,
  inputSchema: taskGetInputSchema,
  name: 'task_get',
  outputPolicy: {
    attachments: { visibleToModel: false },
    errors: { visibleToModel: 'error_text_only' },
    jsonFields: [{ from: 'task' }],
    mode: 'json_fields',
    text: { maxChars: 8_000, visibleToModel: true }
  },
  async execute({ context, input }) {
    if (!context.services.taskGet) {
      throw new Error('task_get service is not configured.');
    }

    const task = await context.services.taskGet({
      sessionId: context.sessionId,
      taskId: input.taskId
    });

    return { task };
  },
  present({ output }) {
    return {
      metadata: {
        found: output.task !== null,
        taskId: output.task ? output.task.id : undefined
      },
      outputText: output.task
        ? `Task ${String(output.task.id)}: ${String(output.task.title)}`
        : 'Task not found.',
      payload: output
    };
  }
};
