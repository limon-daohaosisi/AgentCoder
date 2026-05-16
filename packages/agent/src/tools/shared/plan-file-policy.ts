import path from 'node:path';
import { access } from 'node:fs/promises';
import type { ToolExecutionContext } from '../core.js';
import { resolveWorkspacePath, toWorkspaceRelativePath } from './path.js';

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolvePlanFilePolicy(input: {
  context: ToolExecutionContext;
  filePath: string;
}) {
  const absolutePath = await resolveWorkspacePath(
    input.context.workspaceRoot,
    input.filePath
  );
  const relativePath = toWorkspaceRelativePath(
    input.context.workspaceRoot,
    absolutePath
  );
  const planFilePath = input.context.planContext?.filePath;

  return {
    absolutePath,
    exists: await fileExists(absolutePath),
    isCurrentPlanFile:
      input.context.planContext?.variant === 'plan' &&
      Boolean(planFilePath) &&
      path.posix.normalize(relativePath) ===
        path.posix.normalize(planFilePath ?? ''),
    relativePath
  };
}

export async function assertPlanFileWriteAllowed(input: {
  context: ToolExecutionContext;
  filePath: string;
  mode: 'edit' | 'write';
}) {
  const policy = await resolvePlanFilePolicy({
    context: input.context,
    filePath: input.filePath
  });

  if (input.context.planContext?.variant !== 'plan') {
    return policy;
  }

  if (!policy.isCurrentPlanFile) {
    throw new Error(
      `In plan mode, ${input.mode} may only target the current plan file.`
    );
  }

  if (input.mode === 'write' && policy.exists) {
    throw new Error(
      'In plan mode, write is only allowed when creating the current plan file for the first time.'
    );
  }

  if (input.mode === 'edit' && !policy.exists) {
    throw new Error(
      'In plan mode, edit is only allowed after the current plan file already exists.'
    );
  }

  return policy;
}

export function resolveApprovalMode(input: {
  context: ToolExecutionContext;
  isCurrentPlanFile: boolean;
}) {
  return input.context.planContext?.variant === 'plan' &&
    input.isCurrentPlanFile
    ? 'never'
    : 'required';
}
