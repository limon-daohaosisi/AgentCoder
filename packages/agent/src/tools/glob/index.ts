import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import {
  resolveWorkspaceDirectory,
  resolveWorkspacePath,
  toWorkspaceRelativePath
} from '../shared/path.js';
import {
  compileGlobMatcher,
  listFilesRecursively,
  sortFilesByMtime
} from '../shared/fs-search.js';
import {
  RipgrepUnavailableError,
  runRipgrepCommand
} from '../shared/ripgrep.js';
import { GLOB_TOOL_PROMPT } from './prompt.js';

const MAX_RESULTS = 100;

export const globInputSchema = z
  .object({
    path: z.string().trim().min(1).optional(),
    pattern: z.string().trim().min(1)
  })
  .strict();

export const globToolDefinition: ToolDefinition<
  typeof globInputSchema,
  {
    count: number;
    filePath?: string;
    pattern: string;
    results: string[];
    truncated: boolean;
  }
> = {
  approval: 'never',
  description: GLOB_TOOL_PROMPT,
  async execute({ context, input }) {
    const cwd = await resolveWorkspaceDirectory(
      context.workspaceRoot,
      input.path
    );
    let rawPaths: string[];

    try {
      const result = await runRipgrepCommand({
        args: ['--files', '--glob', input.pattern],
        cwd,
        signal: context.abortSignal,
        timeoutMs: 30_000
      });

      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr || `ripgrep glob failed with code ${result.exitCode}`
        );
      }

      rawPaths = await Promise.all(
        result.stdout
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => resolveWorkspacePath(cwd, line))
      );
    } catch (error) {
      if (!(error instanceof RipgrepUnavailableError)) {
        throw error;
      }

      const pattern = compileGlobMatcher(input.pattern);
      const files = await listFilesRecursively(cwd);

      rawPaths = files.filter((absolutePath) => {
        const relativePath = toWorkspaceRelativePath(cwd, absolutePath);
        return pattern(relativePath);
      });
    }

    const withMtime = (await sortFilesByMtime(rawPaths)).map((item) => ({
      ...item,
      relativePath: toWorkspaceRelativePath(
        context.workspaceRoot,
        item.absolutePath
      )
    }));
    const results = withMtime
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .map((item) => item.relativePath);

    return {
      count: results.length,
      filePath: input.path,
      pattern: input.pattern,
      results: results.slice(0, MAX_RESULTS),
      truncated: results.length > MAX_RESULTS
    };
  },
  inputSchema: globInputSchema,
  name: 'glob',
  present({ output }) {
    const prefix = output.truncated
      ? `(Showing first ${output.results.length} of ${output.count} matches)`
      : '';

    return {
      metadata: {
        count: output.count,
        filePath: output.filePath,
        pattern: output.pattern,
        truncated: output.truncated
      },
      outputText: [prefix, ...output.results].filter(Boolean).join('\n'),
      payload: output
    };
  }
};
