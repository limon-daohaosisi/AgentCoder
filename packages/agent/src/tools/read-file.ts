import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { resolveWorkspacePath } from './guards.js';
import type { ToolDefinition } from './types.js';

export type ReadFileToolInput = {
  path: string;
};

export const readFileInputSchema = z
  .object({
    path: z.string().trim().min(1)
  })
  .strict();

export const readFileToolDefinition: ToolDefinition = {
  description: 'Read a UTF-8 text file inside the current workspace.',
  inputSchema: {
    additionalProperties: false,
    properties: {
      path: {
        description: 'Relative path from the workspace root.',
        type: 'string'
      }
    },
    required: ['path'],
    type: 'object'
  },
  name: 'read_file'
};

export async function readFileTool(
  input: ReadFileToolInput,
  workspaceRoot: string,
  options: { signal?: AbortSignal } = {}
) {
  if (options.signal?.aborted) {
    throw new Error('Run cancelled by user');
  }

  const absolutePath = resolveWorkspacePath(workspaceRoot, input.path);
  const content = await readFile(absolutePath, 'utf8');

  return {
    content,
    path: input.path
  };
}
