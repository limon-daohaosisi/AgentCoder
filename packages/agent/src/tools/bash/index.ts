import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { assertNonInteractiveCommand } from '../guards.js';
import { assertBuildOnlyToolAllowed } from '../shared/mode-policy.js';
import {
  resolveWorkspaceDirectory,
  toWorkspaceRelativePath
} from '../shared/path.js';
import { runSpawnedProcess } from '../shared/process.js';
import { BASH_TOOL_PROMPT } from './prompt.js';

const DEFAULT_TIMEOUT_MS = 120_000;

export const bashInputSchema = z
  .object({
    command: z.string().trim().min(1),
    description: z.string().trim().min(1),
    timeoutMs: z.number().int().positive().optional(),
    workdir: z.string().trim().min(1).optional()
  })
  .strict();

export const bashToolDefinition: ToolDefinition<
  typeof bashInputSchema,
  {
    command: string;
    description: string;
    durationMs: number;
    exitCode: null | number;
    stderr: string;
    stdout: string;
    timedOut: boolean;
    stderrOutputPath?: string;
    stderrTotalBytes: number;
    stdoutOutputPath?: string;
    stdoutTotalBytes: number;
    truncated: boolean;
    workdir: string;
  }
> = {
  approval: 'required',
  outputPolicy: {
    attachments: { visibleToModel: false },
    errors: { visibleToModel: 'error_text_only' },
    mode: 'text_only',
    text: { maxChars: 12_000, visibleToModel: true }
  },
  async buildApproval({ context, input }) {
    assertBuildOnlyToolAllowed({ context, toolName: 'bash' });
    const workdir = await resolveWorkspaceDirectory(
      context.workspaceRoot,
      input.workdir
    );

    return {
      command: input.command,
      description: input.description,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      workdir: toWorkspaceRelativePath(context.workspaceRoot, workdir)
    };
  },
  description: BASH_TOOL_PROMPT,
  async execute({ context, input }) {
    assertBuildOnlyToolAllowed({ context, toolName: 'bash' });
    assertNonInteractiveCommand(input.command);

    const cwd = await resolveWorkspaceDirectory(
      context.workspaceRoot,
      input.workdir
    );
    const startedAt = Date.now();
    const result = await runSpawnedProcess({
      args: ['-lc', input.command],
      command: 'bash',
      cwd,
      maxCaptureBytes: 30_000,
      signal: context.abortSignal,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    });

    return {
      command: input.command,
      description: input.description,
      durationMs: Date.now() - startedAt,
      exitCode: result.exitCode,
      stderr: result.stderr.text,
      stderrOutputPath: result.stderr.outputPath,
      stderrTotalBytes: result.stderr.totalBytes,
      stdout: result.stdout.text,
      stdoutOutputPath: result.stdout.outputPath,
      stdoutTotalBytes: result.stdout.totalBytes,
      timedOut: result.timedOut,
      truncated: result.stdout.truncated || result.stderr.truncated,
      workdir: toWorkspaceRelativePath(context.workspaceRoot, cwd)
    };
  },
  inputSchema: bashInputSchema,
  name: 'bash',
  present({ output }) {
    const modelNotes: string[] = [];
    const internalNotes: string[] = [];

    if (output.stdoutOutputPath) {
      modelNotes.push(
        `STDOUT was truncated after ${output.stdout.length} preview characters (${output.stdoutTotalBytes} bytes total).`
      );
      internalNotes.push(
        `STDOUT was truncated. Full output saved to ${output.stdoutOutputPath} (${output.stdoutTotalBytes} bytes).`
      );
    }

    if (output.stderrOutputPath) {
      modelNotes.push(
        `STDERR was truncated after ${output.stderr.length} preview characters (${output.stderrTotalBytes} bytes total).`
      );
      internalNotes.push(
        `STDERR was truncated. Full output saved to ${output.stderrOutputPath} (${output.stderrTotalBytes} bytes).`
      );
    }

    if (output.timedOut) {
      modelNotes.push('Command timed out before completion.');
      internalNotes.push('Command timed out before completion.');
    }

    return {
      outputText: [
        `Exit code: ${String(output.exitCode ?? 'null')}`,
        '',
        'STDOUT:',
        output.stdout || '(empty)',
        '',
        'STDERR:',
        output.stderr || '(empty)',
        ...(modelNotes.length > 0 ? ['', ...modelNotes] : [])
      ].join('\n'),
      metadata: {
        command: output.command,
        description: output.description,
        durationMs: output.durationMs,
        exitCode: output.exitCode,
        stderrOutputPath: output.stderrOutputPath,
        stderrTotalBytes: output.stderrTotalBytes,
        stdoutOutputPath: output.stdoutOutputPath,
        stdoutTotalBytes: output.stdoutTotalBytes,
        timedOut: output.timedOut,
        truncated: output.truncated,
        uiNotes: internalNotes,
        workdir: output.workdir
      },
      payload: output
    };
  }
};
