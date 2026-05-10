import { readdir, readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { buildFileSnapshotArtifact } from '../shared/file-snapshot.js';
import {
  resolveWorkspacePath,
  toWorkspaceRelativePath
} from '../shared/path.js';
import { formatNumberedLines } from '../shared/truncation.js';
import { READ_TOOL_PROMPT } from './prompt.js';

const DEFAULT_LIMIT = 2_000;

export const readInputSchema = z
  .object({
    filePath: z.string().trim().min(1),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().positive().optional()
  })
  .strict();

function toLines(content: string) {
  const normalized = content.replaceAll('\r\n', '\n');
  const lines = normalized.split('\n');

  if (lines.at(-1) === '') {
    lines.pop();
  }

  return lines;
}

export const readToolDefinition: ToolDefinition<
  typeof readInputSchema,
  {
    bytesRead: number;
    content?: string;
    entries?: string[];
    filePath: string;
    fullRead: boolean;
    limit: number;
    offset: number;
    snapshotArtifactId?: string;
    totalLines?: number;
    truncated: boolean;
    type: 'directory' | 'file';
  }
> = {
  approval: 'never',
  description: READ_TOOL_PROMPT,
  outputPolicy: {
    attachments: { visibleToModel: false },
    errors: { visibleToModel: 'error_text_only' },
    jsonFields: [
      { from: 'content', maxChars: 12_000 },
      { from: 'filePath' },
      { from: 'fullRead' },
      { from: 'limit' },
      { from: 'offset' },
      { from: 'totalLines' },
      { from: 'truncated' },
      { from: 'type' }
    ],
    mode: 'json_fields',
    text: { maxChars: 16_000, visibleToModel: true }
  },
  async execute({ context, input }) {
    const offset = input.offset ?? 1;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const absolutePath = await resolveWorkspacePath(
      context.workspaceRoot,
      input.filePath
    );
    const fileStat = await stat(absolutePath);
    const filePath = toWorkspaceRelativePath(
      context.workspaceRoot,
      absolutePath
    );

    if (fileStat.isDirectory()) {
      const entries = (await readdir(absolutePath, { withFileTypes: true }))
        .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
        .sort((left, right) => left.localeCompare(right));

      return {
        bytesRead: entries.join('\n').length,
        entries,
        filePath,
        fullRead: true,
        limit,
        offset,
        truncated: false,
        type: 'directory'
      };
    }

    const fullContent = await readFile(absolutePath, 'utf8');
    const lines = toLines(fullContent);
    const startIndex = Math.max(0, offset - 1);
    const slicedLines = lines.slice(startIndex, startIndex + limit);
    const numbered = formatNumberedLines(slicedLines, offset);
    const truncated = numbered.truncated || startIndex + limit < lines.length;
    const fullRead = startIndex === 0 && startIndex + limit >= lines.length;
    const snapshot = buildFileSnapshotArtifact({
      content: fullContent,
      fullRead,
      lineCount: lines.length,
      path: filePath,
      previewLimit: limit,
      previewOffset: offset,
      readAt: context.now(),
      size: fileStat.size,
      statMtimeMs: fileStat.mtimeMs,
      truncated
    });
    const snapshotArtifact = await context.fileSnapshots.create({
      sessionId: context.sessionId,
      snapshot,
      toolCallId: context.toolCallId
    });

    return {
      bytesRead: Buffer.byteLength(fullContent, 'utf8'),
      content: numbered.text,
      filePath,
      fullRead,
      limit,
      offset,
      snapshotArtifactId: snapshotArtifact.artifactId || undefined,
      totalLines: lines.length,
      truncated,
      type: 'file'
    };
  },
  inputSchema: readInputSchema,
  name: 'read',
  present({ output }) {
    if (output.type === 'directory') {
      const body = output.entries?.join('\n') ?? '';

      return {
        metadata: {
          bytesRead: output.bytesRead,
          filePath: output.filePath,
          fullRead: output.fullRead,
          limit: output.limit,
          offset: output.offset,
          truncated: output.truncated,
          type: output.type
        },
        outputText: `<path>${output.filePath}</path>\n<type>directory</type>\n<content>\n${body}\n</content>`,
        payload: output
      };
    }

    const footer = output.truncated
      ? `(Showing lines ${output.offset}-${Math.min(output.offset - 1 + output.limit, output.totalLines ?? output.limit)} of ${output.totalLines ?? output.limit}. Use offset=${output.offset - 1 + output.limit + 1} to continue.)`
      : `(End of file - total ${output.totalLines ?? 0} lines)`;

    return {
      metadata: {
        bytesRead: output.bytesRead,
        filePath: output.filePath,
        fullRead: output.fullRead,
        limit: output.limit,
        offset: output.offset,
        snapshotArtifactId: output.snapshotArtifactId,
        totalLines: output.totalLines,
        truncated: output.truncated,
        type: output.type
      },
      outputText: `<path>${output.filePath}</path>\n<type>file</type>\n<content>\n${output.content ?? ''}\n</content>\n${footer}`,
      payload: output
    };
  }
};
