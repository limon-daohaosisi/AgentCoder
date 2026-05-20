import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TASK_UPDATE_TOOL_PROMPT } from './prompt.js';

export const taskUpdateInputSchema = z
  .object({
    acceptanceCriteria: z.array(z.string().trim().min(1)).optional(),
    completedAt: z.string().trim().min(1).nullable().optional(),
    description: z.string().trim().min(1).nullable().optional(),
    lastErrorText: z.string().trim().min(1).nullable().optional(),
    position: z.number().int().positive().optional(),
    startedAt: z.string().trim().min(1).nullable().optional(),
    status: z
      .enum([
        'todo',
        'ready',
        'running',
        'blocked',
        'waiting_approval',
        'done',
        'failed'
      ])
      .optional(),
    summaryText: z.string().trim().min(1).nullable().optional(),
    taskId: z.string().trim().min(1),
    title: z.string().trim().min(1).optional()
  })
  .strict();

export const taskUpdateExecutionOnlyInputSchema = z
  .object({
    completedAt: z.string().trim().min(1).nullable().optional(),
    lastErrorText: z.string().trim().min(1).nullable().optional(),
    startedAt: z.string().trim().min(1).nullable().optional(),
    status: z
      .enum([
        'todo',
        'ready',
        'running',
        'blocked',
        'waiting_approval',
        'done',
        'failed'
      ])
      .optional(),
    summaryText: z.string().trim().min(1).nullable().optional(),
    taskId: z.string().trim().min(1)
  })
  .strict();

export const taskUpdateToolDefinition: ToolDefinition<
  typeof taskUpdateInputSchema,
  {
    task: Record<string, unknown>;
  }
> = {
  approval: 'never',
  description: TASK_UPDATE_TOOL_PROMPT,
  inputSchema: taskUpdateInputSchema,
  name: 'task_update',
  outputPolicy: {
    attachments: { visibleToModel: false },
    errors: { visibleToModel: 'error_text_only' },
    jsonFields: [{ from: 'task' }],
    mode: 'json_fields',
    text: { maxChars: 8_000, visibleToModel: true }
  },
  async execute({ context, input }) {
    if (!context.services.taskUpdate) {
      throw new Error('task_update service is not configured.');
    }

    const task = await context.services.taskUpdate({
      acceptanceCriteria: input.acceptanceCriteria,
      completedAt: input.completedAt,
      description: input.description,
      lastErrorText: input.lastErrorText,
      position: input.position,
      sessionId: context.sessionId,
      startedAt: input.startedAt,
      status: input.status,
      summaryText: input.summaryText,
      taskId: input.taskId,
      title: input.title
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
      outputText: `Updated task ${String(output.task.id)} to ${String(output.task.status)}.`,
      payload: output
    };
  }
};
