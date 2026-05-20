import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createFileDiff } from '../diff.js';
import type { ToolDefinition } from '../types.js';
import {
  assertFreshSnapshot,
  buildFileSnapshotArtifact
} from '../shared/file-snapshot.js';
import { formatDiagnosticsText } from '../shared/diagnostics.js';
import {
  assertPlanFileWriteAllowed,
  resolvePlanFilePolicy,
  resolveApprovalMode
} from '../shared/plan-file-policy.js';
import {
  resolveWorkspacePath,
  toWorkspaceRelativePath
} from '../shared/path.js';
import { countTextLines } from '../shared/text.js';
import { WRITE_TOOL_PROMPT } from './prompt.js';

export const writeInputSchema = z
  .object({
    content: z.string(),
    filePath: z.string().trim().min(1)
  })
  .strict();

async function readExistingFile(absolutePath: string) {
  const previousContent = await readFile(absolutePath, 'utf8').catch(
    () => null
  );

  return previousContent;
}

export const writeToolDefinition: ToolDefinition<
  typeof writeInputSchema,
  {
    bytesWritten: number;
    diff: string;
    diagnostics: string;
    exists: boolean;
    filePath: string;
    snapshotArtifactId?: string;
    staleChecked: boolean;
  }
> = {
  approval: 'required',
  outputPolicy: {
    attachments: { visibleToModel: false },
    errors: { visibleToModel: 'error_text_only' },
    mode: 'text_only',
    text: { maxChars: 4_000, visibleToModel: true }
  },
  async buildApproval({ context, input }) {
    const policy = await assertPlanFileWriteAllowed({
      context,
      filePath: input.filePath,
      mode: 'write'
    });
    const absolutePath = policy.absolutePath;
    const relativePath = policy.relativePath;
    const previousContent = await readExistingFile(absolutePath);
    const exists = previousContent !== null;

    if (exists) {
      await assertFreshSnapshot({
        absolutePath,
        path: relativePath,
        requireFullRead: true,
        sessionId: context.sessionId,
        store: context.fileSnapshots
      });
    }

    return {
      bytes: Buffer.byteLength(input.content, 'utf8'),
      diff: createFileDiff({
        filePath: relativePath,
        nextContent: input.content,
        previousContent: previousContent ?? ''
      }).diff,
      exists,
      filePath: relativePath,
      summary: exists
        ? 'Replace file content after diff approval.'
        : 'Create file after diff approval.'
    };
  },
  description: WRITE_TOOL_PROMPT,
  async execute({ context, input }) {
    const policy = await assertPlanFileWriteAllowed({
      context,
      filePath: input.filePath,
      mode: 'write'
    });
    const absolutePath = policy.absolutePath;
    const relativePath = policy.relativePath;
    const previousContent = await readExistingFile(absolutePath);
    const exists = previousContent !== null;

    if (exists) {
      await assertFreshSnapshot({
        absolutePath,
        path: relativePath,
        requireFullRead: true,
        sessionId: context.sessionId,
        store: context.fileSnapshots
      });
    }

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.content, 'utf8');

    const currentStat = await stat(absolutePath);
    const snapshot = buildFileSnapshotArtifact({
      content: input.content,
      fullRead: true,
      lineCount: countTextLines(input.content),
      path: relativePath,
      readAt: context.now(),
      size: currentStat.size,
      statMtimeMs: currentStat.mtimeMs,
      truncated: false
    });
    const snapshotArtifact = await context.fileSnapshots.create({
      sessionId: context.sessionId,
      snapshot,
      toolCallId: context.toolCallId
    });
    const diagnostics = await context.diagnostics.collectForFiles([
      absolutePath
    ]);
    const diagnosticsText = formatDiagnosticsText({
      context,
      diagnostics
    });
    const diff = createFileDiff({
      filePath: relativePath,
      nextContent: input.content,
      previousContent: previousContent ?? ''
    }).diff;

    return {
      bytesWritten: Buffer.byteLength(input.content, 'utf8'),
      diff,
      diagnostics: diagnosticsText,
      exists,
      filePath: relativePath,
      snapshotArtifactId: snapshotArtifact.artifactId || undefined,
      staleChecked: exists
    };
  },
  inputSchema: writeInputSchema,
  name: 'write',
  present({ output }) {
    return {
      metadata: {
        bytesWritten: output.bytesWritten,
        diff: output.diff,
        diagnostics: output.diagnostics,
        exists: output.exists,
        filePath: output.filePath,
        snapshotArtifactId: output.snapshotArtifactId,
        staleChecked: output.staleChecked
      },
      outputText: ['Wrote file successfully.', output.diagnostics]
        .filter(Boolean)
        .join('\n\n'),
      payload: output
    };
  },
  resolveApproval({ context, input }) {
    return resolvePlanFilePolicy({ context, filePath: input.filePath }).then(
      (policy) =>
        resolveApprovalMode({
          context,
          isCurrentPlanFile: policy.isCurrentPlanFile
        })
    );
  }
};
