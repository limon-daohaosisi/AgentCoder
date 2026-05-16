import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TASK_LIST_TOOL_PROMPT } from './prompt.js';

export const taskListInputSchema = z.object({}).strict();

export const taskListToolDefinition: ToolDefinition<
  typeof taskListInputSchema,
  {
    currentTaskId?: string;
    tasks: Array<Record<string, unknown>>;
  }
> = {
  approval: 'never',
  description: TASK_LIST_TOOL_PROMPT,
  inputSchema: taskListInputSchema,
  name: 'task_list',
  outputPolicy: {
    attachments: { visibleToModel: false },
    errors: { visibleToModel: 'error_text_only' },
    jsonFields: [{ from: 'currentTaskId' }, { from: 'tasks' }],
    mode: 'json_fields',
    text: { maxChars: 12_000, visibleToModel: true }
  },
  async execute({ context }) {
    if (!context.services.taskList) {
      throw new Error('task_list service is not configured.');
    }

    const result = await context.services.taskList({ sessionId: context.sessionId });
    return result;
  },
  present({ output }) {
    const lines = output.tasks.map(
      (task) => `- ${String(task.id)} [${String(task.status)}] ${String(task.title)}`
    );

    return {
      metadata: {
        currentTaskId: output.currentTaskId,
        taskCount: output.tasks.length
      },
      outputText: lines.length > 0 ? lines.join('\n') : 'No tasks found.',
      payload: output
    };
  }
};
