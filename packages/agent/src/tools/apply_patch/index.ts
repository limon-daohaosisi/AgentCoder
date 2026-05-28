import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createFileDiff } from '../diff.js';
import type { ToolDefinition } from '../types.js';
import { formatDiagnosticsText } from '../shared/diagnostics.js';
import { assertBuildOnlyToolAllowed } from '../shared/mode-policy.js';
import {
  buildFileSnapshotArtifact,
  sha256Text
} from '../shared/file-snapshot.js';
import {
  resolveWorkspacePath,
  toWorkspaceRelativePath
} from '../shared/path.js';
import { countTextLines } from '../shared/text.js';
import { APPLY_PATCH_TOOL_PROMPT } from './prompt.js';
import { deriveUpdatedContent, parsePatch, type PatchHunk } from './patch.js';

type FileFingerprint = {
  exists: boolean;
  mtimeMs?: number;
  sha256?: string;
  size?: number;
};

export type PatchFileSummary = {
  additions: number;
  beforeFingerprint?: FileFingerprint;
  change: 'add' | 'delete' | 'move' | 'update';
  deletions: number;
  destinationFingerprint?: FileFingerprint;
  diff: string;
  movePath?: string;
  overwritesDestination: boolean;
  path: string;
  relativePath: string;
};

type PatchFilePlan = PatchFileSummary & {
  after: string;
  before: string;
  filePath: string;
  moveAbsolutePath?: string;
};

type ApplyPatchApprovalPayload = {
  additions: number;
  deletions: number;
  diff: string;
  files: PatchFileSummary[];
  summary: string;
};

type ApplyPatchExecutionOutput = {
  diagnostics: string;
  diff: string;
  files: PatchFileSummary[];
  snapshotArtifactIds: string[];
};

type ExistingPathState =
  | { fingerprint: FileFingerprint; kind: 'directory' | 'missing' }
  | {
      content: string;
      fingerprint: FileFingerprint;
      kind: 'file';
    };

const fileFingerprintSchema = z
  .object({
    exists: z.boolean(),
    mtimeMs: z.number().optional(),
    sha256: z.string().optional(),
    size: z.number().optional()
  })
  .strict();

const patchFileSummarySchema = z
  .object({
    additions: z.number(),
    beforeFingerprint: fileFingerprintSchema.optional(),
    change: z.enum(['add', 'delete', 'move', 'update']),
    deletions: z.number(),
    destinationFingerprint: fileFingerprintSchema.optional(),
    diff: z.string(),
    movePath: z.string().optional(),
    overwritesDestination: z.boolean(),
    path: z.string(),
    relativePath: z.string()
  })
  .strict();

const applyPatchApprovalPayloadSchema = z
  .object({
    additions: z.number(),
    deletions: z.number(),
    diff: z.string(),
    files: z.array(patchFileSummarySchema),
    summary: z.string()
  })
  .strict();

function ensureTrailingNewline(content: string) {
  return content.endsWith('\n') ? content : `${content}\n`;
}

async function readExistingPathState(
  absolutePath: string
): Promise<ExistingPathState> {
  try {
    const currentStat = await stat(absolutePath);

    if (currentStat.isDirectory()) {
      return {
        fingerprint: { exists: true },
        kind: 'directory'
      };
    }

    const content = await readFile(absolutePath, 'utf8');

    return {
      content,
      fingerprint: {
        exists: true,
        mtimeMs: currentStat.mtimeMs,
        sha256: sha256Text(content),
        size: currentStat.size
      },
      kind: 'file'
    };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return {
        fingerprint: { exists: false },
        kind: 'missing'
      };
    }

    throw error;
  }
}

function sameFingerprint(
  left: FileFingerprint | undefined,
  right: FileFingerprint | undefined
) {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.exists === right.exists &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256 &&
    left.size === right.size
  );
}

async function assertPatchShape(hunks: PatchHunk[], workspaceRoot: string) {
  const seenSourcePaths = new Set<string>();
  const seenTargetPaths = new Set<string>();

  for (const hunk of hunks) {
    const sourcePath = toWorkspaceRelativePath(
      workspaceRoot,
      await resolveWorkspacePath(workspaceRoot, hunk.path)
    );
    const targetPath =
      hunk.type === 'update' && hunk.movePath
        ? toWorkspaceRelativePath(
            workspaceRoot,
            await resolveWorkspacePath(workspaceRoot, hunk.movePath)
          )
        : sourcePath;

    if (seenSourcePaths.has(sourcePath)) {
      throw new Error(
        `apply_patch verification failed: Duplicate patch operation for ${sourcePath}.`
      );
    }

    if (seenTargetPaths.has(targetPath)) {
      throw new Error(
        `apply_patch verification failed: Duplicate patch target ${targetPath}.`
      );
    }

    if (hunk.type === 'update' && hunk.chunks.length === 0 && !hunk.movePath) {
      throw new Error(
        `apply_patch verification failed: Update File requires at least one @@ chunk for ${sourcePath}.`
      );
    }

    seenSourcePaths.add(sourcePath);
    seenTargetPaths.add(targetPath);
  }
}

async function planPatch(input: { patchText: string; workspaceRoot: string }) {
  const { hunks } = parsePatch(input.patchText);

  if (hunks.length === 0) {
    throw new Error('patch rejected: empty patch');
  }

  await assertPatchShape(hunks, input.workspaceRoot);

  const files: PatchFilePlan[] = [];

  for (const hunk of hunks) {
    const filePath = await resolveWorkspacePath(input.workspaceRoot, hunk.path);
    const sourcePath = toWorkspaceRelativePath(input.workspaceRoot, filePath);

    if (hunk.type === 'add') {
      const targetState = await readExistingPathState(filePath);

      if (targetState.kind === 'directory') {
        throw new Error(
          `apply_patch verification failed: Add File target is a directory: ${sourcePath}`
        );
      }

      if (targetState.kind === 'file') {
        throw new Error(
          `apply_patch verification failed: Add File target already exists: ${sourcePath}`
        );
      }

      const after = ensureTrailingNewline(hunk.contents);
      const diff = createFileDiff({
        filePath: sourcePath,
        nextContent: after,
        previousContent: ''
      });

      files.push({
        additions: diff.additions,
        after,
        before: '',
        change: 'add',
        deletions: diff.deletions,
        destinationFingerprint: targetState.fingerprint,
        diff: diff.diff,
        filePath,
        overwritesDestination: false,
        path: sourcePath,
        relativePath: sourcePath
      });
      continue;
    }

    const sourceState = await readExistingPathState(filePath);

    if (sourceState.kind !== 'file') {
      if (hunk.type === 'delete') {
        throw new Error(
          `apply_patch verification failed: Failed to read file to delete: ${filePath}`
        );
      }

      throw new Error(
        `apply_patch verification failed: Failed to read file to update: ${filePath}`
      );
    }

    if (hunk.type === 'delete') {
      const diff = createFileDiff({
        filePath: sourcePath,
        nextContent: '',
        previousContent: sourceState.content
      });

      files.push({
        additions: diff.additions,
        after: '',
        before: sourceState.content,
        beforeFingerprint: sourceState.fingerprint,
        change: 'delete',
        deletions: diff.deletions,
        diff: diff.diff,
        filePath,
        overwritesDestination: false,
        path: sourcePath,
        relativePath: sourcePath
      });
      continue;
    }

    const requestedMovePath = hunk.movePath
      ? await resolveWorkspacePath(input.workspaceRoot, hunk.movePath)
      : undefined;
    const isMove = Boolean(requestedMovePath && requestedMovePath !== filePath);
    const moveAbsolutePath = isMove ? requestedMovePath : undefined;
    const movePath = moveAbsolutePath
      ? toWorkspaceRelativePath(input.workspaceRoot, moveAbsolutePath)
      : undefined;
    const destinationState = moveAbsolutePath
      ? await readExistingPathState(moveAbsolutePath)
      : undefined;

    if (destinationState?.kind === 'directory') {
      throw new Error(
        `apply_patch verification failed: Move target is a directory: ${movePath}`
      );
    }

    const after =
      hunk.chunks.length === 0
        ? sourceState.content
        : deriveUpdatedContent({
            chunks: hunk.chunks,
            content: sourceState.content,
            filePath
          });
    const diff = createFileDiff({
      filePath: sourcePath,
      nextContent: after,
      nextFilePath: movePath ?? sourcePath,
      previousContent: sourceState.content,
      previousFilePath: sourcePath
    });

    files.push({
      additions: diff.additions,
      after,
      before: sourceState.content,
      beforeFingerprint: sourceState.fingerprint,
      change: moveAbsolutePath ? 'move' : 'update',
      deletions: diff.deletions,
      destinationFingerprint: destinationState?.fingerprint,
      diff: diff.diff,
      filePath,
      moveAbsolutePath,
      movePath,
      overwritesDestination: destinationState?.kind === 'file',
      path: sourcePath,
      relativePath: movePath ?? sourcePath
    });
  }

  const diff = files
    .map((file) => file.diff)
    .filter(Boolean)
    .join('\n\n');

  return {
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    diff,
    files
  };
}

function toPatchFileSummary(file: PatchFilePlan): PatchFileSummary {
  return {
    additions: file.additions,
    beforeFingerprint: file.beforeFingerprint,
    change: file.change,
    deletions: file.deletions,
    destinationFingerprint: file.destinationFingerprint,
    diff: file.diff,
    movePath: file.movePath,
    overwritesDestination: file.overwritesDestination,
    path: file.path,
    relativePath: file.relativePath
  };
}

function assertApprovalPayloadMatchesPlan(input: {
  approvalPayload: Record<string, unknown>;
  plan: Awaited<ReturnType<typeof planPatch>>;
}) {
  const approved = applyPatchApprovalPayloadSchema.parse(input.approvalPayload);
  const currentFiles = input.plan.files.map(toPatchFileSummary);

  if (
    approved.additions !== input.plan.additions ||
    approved.deletions !== input.plan.deletions ||
    approved.diff !== input.plan.diff ||
    approved.files.length !== currentFiles.length
  ) {
    throw new Error(
      'Patch no longer matches the approved file state. Re-run apply_patch.'
    );
  }

  for (let index = 0; index < approved.files.length; index += 1) {
    const approvedFile = approved.files[index];
    const currentFile = currentFiles[index];

    if (!approvedFile || !currentFile) {
      throw new Error(
        'Patch no longer matches the approved file state. Re-run apply_patch.'
      );
    }

    if (
      approvedFile.additions !== currentFile.additions ||
      approvedFile.change !== currentFile.change ||
      approvedFile.deletions !== currentFile.deletions ||
      approvedFile.diff !== currentFile.diff ||
      approvedFile.movePath !== currentFile.movePath ||
      approvedFile.overwritesDestination !==
        currentFile.overwritesDestination ||
      approvedFile.path !== currentFile.path ||
      approvedFile.relativePath !== currentFile.relativePath ||
      !sameFingerprint(
        approvedFile.beforeFingerprint,
        currentFile.beforeFingerprint
      ) ||
      !sameFingerprint(
        approvedFile.destinationFingerprint,
        currentFile.destinationFingerprint
      )
    ) {
      throw new Error(
        'Patch no longer matches the approved file state. Re-run apply_patch.'
      );
    }
  }
}

function createApprovalStateMismatchError() {
  return new Error(
    'Patch no longer matches the approved file state. Re-run apply_patch.'
  );
}

export const applyPatchInputSchema = z
  .object({
    patchText: z.string().min(1)
  })
  .strict();

export const applyPatchToolDefinition: ToolDefinition<
  typeof applyPatchInputSchema,
  ApplyPatchExecutionOutput
> = {
  approval: 'required',
  outputPolicy: {
    attachments: { visibleToModel: false },
    errors: { visibleToModel: 'error_text_only' },
    mode: 'text_only',
    text: { maxChars: 6_000, visibleToModel: true }
  },
  async buildApproval({ context, input }) {
    assertBuildOnlyToolAllowed({ context, toolName: 'apply_patch' });
    const plan = await planPatch({
      patchText: input.patchText,
      workspaceRoot: context.workspaceRoot
    });

    return {
      additions: plan.additions,
      deletions: plan.deletions,
      diff: plan.diff,
      files: plan.files.map(toPatchFileSummary),
      summary: 'Apply structured patch after diff approval.'
    } satisfies ApplyPatchApprovalPayload;
  },
  description: APPLY_PATCH_TOOL_PROMPT,
  async execute({ approvalPayload, context, input }) {
    assertBuildOnlyToolAllowed({ context, toolName: 'apply_patch' });
    let plan: Awaited<ReturnType<typeof planPatch>>;

    try {
      plan = await planPatch({
        patchText: input.patchText,
        workspaceRoot: context.workspaceRoot
      });
    } catch (error) {
      if (approvalPayload) {
        throw createApprovalStateMismatchError();
      }

      throw error;
    }

    if (approvalPayload) {
      assertApprovalPayloadMatchesPlan({ approvalPayload, plan });
    }

    const changedFiles: string[] = [];
    const snapshotArtifactIds: string[] = [];

    for (const file of plan.files) {
      switch (file.change) {
        case 'add':
          await mkdir(path.dirname(file.filePath), { recursive: true });
          await writeFile(file.filePath, file.after, 'utf8');
          changedFiles.push(file.filePath);
          break;
        case 'update':
          await writeFile(file.filePath, file.after, 'utf8');
          changedFiles.push(file.filePath);
          break;
        case 'move':
          if (!file.moveAbsolutePath) {
            throw new Error('apply_patch move target is missing.');
          }

          await mkdir(path.dirname(file.moveAbsolutePath), { recursive: true });
          await writeFile(file.moveAbsolutePath, file.after, 'utf8');
          await unlink(file.filePath);
          changedFiles.push(file.moveAbsolutePath);
          break;
        case 'delete':
          await unlink(file.filePath);
          break;
      }
    }

    for (const targetPath of changedFiles) {
      const relativePath = toWorkspaceRelativePath(
        context.workspaceRoot,
        targetPath
      );
      const content = await readFile(targetPath, 'utf8');
      const currentStat = await stat(targetPath);
      const snapshotArtifact = await context.fileSnapshots.create({
        sessionId: context.sessionId,
        snapshot: buildFileSnapshotArtifact({
          content,
          fullRead: true,
          lineCount: countTextLines(content),
          path: relativePath,
          readAt: context.now(),
          size: currentStat.size,
          statMtimeMs: currentStat.mtimeMs,
          truncated: false
        }),
        toolCallId: context.toolCallId
      });

      if (snapshotArtifact.artifactId) {
        snapshotArtifactIds.push(snapshotArtifact.artifactId);
      }
    }

    const diagnostics = await context.diagnostics.collectForFiles(changedFiles);

    return {
      diagnostics: formatDiagnosticsText({ context, diagnostics }),
      diff: plan.diff,
      files: plan.files.map(toPatchFileSummary),
      snapshotArtifactIds
    };
  },
  inputSchema: applyPatchInputSchema,
  name: 'apply_patch',
  present({ output }) {
    const lines = output.files.map((file) => {
      switch (file.change) {
        case 'add':
          return `A ${file.relativePath}`;
        case 'delete':
          return `D ${file.relativePath}`;
        default:
          return `M ${file.relativePath}`;
      }
    });

    return {
      metadata: {
        diagnostics: output.diagnostics,
        diff: output.diff,
        files: output.files,
        snapshotArtifactIds: output.snapshotArtifactIds
      },
      outputText: [
        'Success. Updated the following files:',
        ...lines,
        output.diagnostics ? '' : undefined,
        output.diagnostics || undefined
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n'),
      payload: output
    };
  }
};
