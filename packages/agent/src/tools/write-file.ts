import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createUnifiedDiff } from './diff.js';
import { resolveWorkspacePath } from './guards.js';
import type { ToolDefinition } from './types.js';

export type WriteFileToolInput = {
  content: string;
  path: string;
};

export const writeFileInputSchema = z
  .object({
    content: z.string(),
    path: z.string().trim().min(1)
  })
  .strict();

export const writeFileToolDefinition: ToolDefinition = {
  description:
    'Replace a UTF-8 text file inside the current workspace. Requires user approval.',
  inputSchema: {
    additionalProperties: false,
    properties: {
      content: {
        description: 'Full next content of the file.',
        type: 'string'
      },
      path: {
        description: 'Relative path from the workspace root.',
        type: 'string'
      }
    },
    required: ['path', 'content'],
    type: 'object'
  },
  name: 'write_file'
};

export async function buildWriteFileApproval(
  input: WriteFileToolInput,
  workspaceRoot: string
) {
  const absolutePath = resolveWorkspacePath(workspaceRoot, input.path);
  const previousContent = await readFile(absolutePath, 'utf8').catch(() => '');

  return {
    diff: createUnifiedDiff(previousContent, input.content),
    path: input.path,
    summary: 'Replace file content after diff approval.'
  };
}

export async function executeWriteFile(
  input: WriteFileToolInput,
  workspaceRoot: string,
  options: { signal?: AbortSignal } = {}
) {
  if (options.signal?.aborted) {
    throw new Error('Run cancelled by user');
  }

  const absolutePath = resolveWorkspacePath(workspaceRoot, input.path);

  await mkdir(path.dirname(absolutePath), { recursive: true });

  if (options.signal?.aborted) {
    throw new Error('Run cancelled by user');
  }

  await writeFile(absolutePath, input.content, 'utf8');

  return {
    bytesWritten: Buffer.byteLength(input.content, 'utf8'),
    path: input.path
  };
}
