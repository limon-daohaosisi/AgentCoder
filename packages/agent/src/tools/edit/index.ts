import { stat, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { createFileDiff } from '../diff.js';
import type { ToolDefinition } from '../types.js';
import {
  assertFreshSnapshot,
  buildFileSnapshotArtifact
} from '../shared/file-snapshot.js';
import { formatDiagnosticsText } from '../shared/diagnostics.js';
import {
  resolveWorkspacePath,
  toWorkspaceRelativePath
} from '../shared/path.js';
import {
  countMatches,
  countTextLines,
  detectLineEnding,
  normalizeForLineEnding
} from '../shared/text.js';
import { EDIT_TOOL_PROMPT } from './prompt.js';

export const editInputSchema = z
  .object({
    filePath: z.string().trim().min(1),
    newString: z.string(),
    oldString: z.string().min(1),
    replaceAll: z.boolean().optional()
  })
  .strict();

function applyEdit(input: {
  content: string;
  filePath: string;
  newString: string;
  oldString: string;
  replaceAll: boolean;
}) {
  const lineEnding = detectLineEnding(input.content);
  const oldString = normalizeForLineEnding(input.oldString, lineEnding);
  const newString = normalizeForLineEnding(input.newString, lineEnding);
  const matches = countMatches(input.content, oldString);

  if (matches === 0) {
    throw new Error(`oldString was not found in ${input.filePath}.`);
  }

  if (!input.replaceAll && matches > 1) {
    throw new Error(
      `oldString matched ${matches} times in ${input.filePath}. Use replaceAll to replace every occurrence.`
    );
  }

  const nextContent = input.replaceAll
    ? input.content.split(oldString).join(newString)
    : input.content.replace(oldString, newString);

  return { matches, nextContent };
}

export const editToolDefinition: ToolDefinition<
  typeof editInputSchema,
  {
    diagnostics: string;
    filePath: string;
    matches: number;
    replaceAll: boolean;
    snapshotArtifactId?: string;
  }
> = {
  approval: 'required',
  async buildApproval({ context, input }) {
    const absolutePath = await resolveWorkspacePath(
      context.workspaceRoot,
      input.filePath
    );
    const relativePath = toWorkspaceRelativePath(
      context.workspaceRoot,
      absolutePath
    );
    const snapshot = await assertFreshSnapshot({
      absolutePath,
      path: relativePath,
      requireFullRead: true,
      sessionId: context.sessionId,
      store: context.fileSnapshots
    });
    const edit = applyEdit({
      content: snapshot.content,
      filePath: input.filePath,
      newString: input.newString,
      oldString: input.oldString,
      replaceAll: input.replaceAll ?? false
    });

    return {
      diff: createFileDiff({
        filePath: relativePath,
        nextContent: edit.nextContent,
        previousContent: snapshot.content
      }).diff,
      filePath: relativePath,
      replaceAll: input.replaceAll ?? false,
      summary: 'Apply targeted file edit after diff approval.'
    };
  },
  description: EDIT_TOOL_PROMPT,
  async execute({ context, input }) {
    const absolutePath = await resolveWorkspacePath(
      context.workspaceRoot,
      input.filePath
    );
    const relativePath = toWorkspaceRelativePath(
      context.workspaceRoot,
      absolutePath
    );
    const snapshot = await assertFreshSnapshot({
      absolutePath,
      path: relativePath,
      requireFullRead: true,
      sessionId: context.sessionId,
      store: context.fileSnapshots
    });
    const edit = applyEdit({
      content: snapshot.content,
      filePath: input.filePath,
      newString: input.newString,
      oldString: input.oldString,
      replaceAll: input.replaceAll ?? false
    });

    await writeFile(absolutePath, edit.nextContent, 'utf8');

    const currentStat = await stat(absolutePath);
    const snapshotArtifact = await context.fileSnapshots.create({
      sessionId: context.sessionId,
      snapshot: buildFileSnapshotArtifact({
        content: edit.nextContent,
        fullRead: true,
        lineCount: countTextLines(edit.nextContent),
        path: relativePath,
        readAt: context.now(),
        size: currentStat.size,
        statMtimeMs: currentStat.mtimeMs,
        truncated: false
      }),
      toolCallId: context.toolCallId
    });
    const diagnostics = await context.diagnostics.collectForFiles([
      absolutePath
    ]);

    return {
      diagnostics: formatDiagnosticsText({ context, diagnostics }),
      filePath: relativePath,
      matches: edit.matches,
      replaceAll: input.replaceAll ?? false,
      snapshotArtifactId: snapshotArtifact.artifactId || undefined
    };
  },
  inputSchema: editInputSchema,
  name: 'edit',
  present({ output }) {
    return {
      metadata: {
        diagnostics: output.diagnostics,
        filePath: output.filePath,
        matches: output.matches,
        replaceAll: output.replaceAll,
        snapshotArtifactId: output.snapshotArtifactId
      },
      outputText: ['Edit applied successfully.', output.diagnostics]
        .filter(Boolean)
        .join('\n\n'),
      payload: output
    };
  }
};
