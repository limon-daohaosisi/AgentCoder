import { z } from 'zod';
import type { ToolName } from '@opencode/shared';
import type { ToolDefinition } from '../types.js';
import { BATCH_TOOL_PROMPT } from './prompt.js';

const batchToolCallSchema = z
  .object({
    parameters: z.record(z.string(), z.unknown()),
    tool: z.string().trim().min(1)
  })
  .strict();

export const batchInputSchema = z
  .object({
    tool_calls: z.array(batchToolCallSchema).min(1)
  })
  .strict();

export type BatchToolInput = z.infer<typeof batchInputSchema>;

export type BatchChildToolCall = {
  parameters: Record<string, unknown>;
  tool: ToolName;
};

export function parseBatchChildToolCalls(input: BatchToolInput) {
  return input.tool_calls.map<BatchChildToolCall>((item) => ({
    parameters: item.parameters,
    tool: item.tool as ToolName
  }));
}

export const batchToolDefinition: ToolDefinition<
  typeof batchInputSchema,
  {
    childCount: number;
  }
> = {
  approval: 'never',
  description: BATCH_TOOL_PROMPT,
  async execute() {
    throw new Error(
      'batch is a model wrapper and cannot be executed directly.'
    );
  },
  inputSchema: batchInputSchema,
  name: 'batch',
  present({ output }) {
    return {
      metadata: {
        childCount: output.childCount
      },
      outputText: `Prepared batch with ${output.childCount} child tool calls.`,
      payload: output
    };
  }
};
