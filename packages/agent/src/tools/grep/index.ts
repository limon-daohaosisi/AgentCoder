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
  searchFileContents,
  sortFilesByMtime
} from '../shared/fs-search.js';
import {
  RipgrepUnavailableError,
  runRipgrepCommand
} from '../shared/ripgrep.js';
import { truncateLine } from '../shared/truncation.js';
import { GREP_TOOL_PROMPT } from './prompt.js';

const MAX_MATCHES = 100;

type GrepMatch = {
  line: number;
  path: string;
  text: string;
};

export const grepInputSchema = z
  .object({
    include: z.string().trim().min(1).optional(),
    path: z.string().trim().min(1).optional(),
    pattern: z.string().trim().min(1)
  })
  .strict();

function parseGrepLine(line: string): {
  absolutePath: string;
  line: number;
  text: string;
} | null {
  const firstColon = line.indexOf(':');
  const secondColon = line.indexOf(':', firstColon + 1);

  if (firstColon === -1 || secondColon === -1) {
    return null;
  }

  const absolutePath = line.slice(0, firstColon);
  const lineNumber = Number(line.slice(firstColon + 1, secondColon));

  if (!Number.isFinite(lineNumber)) {
    return null;
  }

  return {
    absolutePath,
    line: lineNumber,
    text: line.slice(secondColon + 1)
  };
}

export const grepToolDefinition: ToolDefinition<
  typeof grepInputSchema,
  {
    include?: string;
    matches: GrepMatch[];
    path?: string;
    pattern: string;
    totalMatches: number;
    truncated: boolean;
  }
> = {
  approval: 'never',
  description: GREP_TOOL_PROMPT,
  isConcurrencySafe: () => true,
  outputPolicy: {
    attachments: { visibleToModel: false },
    errors: { visibleToModel: 'error_text_only' },
    mode: 'text_only',
    text: { maxChars: 12_000, visibleToModel: true }
  },
  async execute({ context, input }) {
    const cwd = await resolveWorkspaceDirectory(
      context.workspaceRoot,
      input.path
    );
    const args = ['--line-number', '--with-filename', '--color', 'never'];

    if (input.include) {
      args.push('--glob', input.include);
    }

    args.push(input.pattern, cwd);

    let parsed: Array<{ absolutePath: string; line: number; text: string }>;

    try {
      const result = await runRipgrepCommand({
        args,
        cwd: context.workspaceRoot,
        signal: context.abortSignal,
        timeoutMs: 30_000
      });

      if (result.exitCode === 1) {
        parsed = [];
      } else if (result.exitCode !== 0) {
        throw new Error(
          result.stderr || `ripgrep grep failed with code ${result.exitCode}`
        );
      } else {
        parsed = result.stdout
          .split(/\r?\n/u)
          .map((line) => parseGrepLine(line))
          .filter((match): match is NonNullable<typeof match> =>
            Boolean(match)
          );
      }
    } catch (error) {
      if (!(error instanceof RipgrepUnavailableError)) {
        throw error;
      }

      const files = await listFilesRecursively(cwd);
      const includePattern = input.include
        ? compileGlobMatcher(input.include)
        : null;
      const searchPattern = new RegExp(input.pattern, 'u');
      const filteredFiles = files.filter((absolutePath) => {
        if (!includePattern) {
          return true;
        }

        const relativePath = toWorkspaceRelativePath(cwd, absolutePath);
        return includePattern(relativePath);
      });

      parsed = await searchFileContents({
        files: filteredFiles,
        pattern: searchPattern
      });
    }

    const pathToMtime = new Map<string, number>();
    const resolvedPaths = await Promise.all([
      ...new Set(
        parsed.map((item) => resolveWorkspacePath(cwd, item.absolutePath))
      )
    ]);
    const sortedFiles = await sortFilesByMtime(resolvedPaths);

    for (const item of sortedFiles) {
      pathToMtime.set(item.absolutePath, item.mtimeMs);
    }

    const resolvedMatchPaths = new Map<string, string>();

    for (const match of parsed) {
      const key = `${match.absolutePath}:${match.line}:${match.text}`;
      resolvedMatchPaths.set(
        key,
        await resolveWorkspacePath(cwd, match.absolutePath)
      );
    }

    const matches = parsed
      .sort((left, right) => {
        const rightPath = resolvedMatchPaths.get(
          `${right.absolutePath}:${right.line}:${right.text}`
        );
        const leftPath = resolvedMatchPaths.get(
          `${left.absolutePath}:${left.line}:${left.text}`
        );

        return (
          (pathToMtime.get(rightPath ?? '') ?? 0) -
          (pathToMtime.get(leftPath ?? '') ?? 0)
        );
      })
      .map((match) => {
        const resolvedPath = resolvedMatchPaths.get(
          `${match.absolutePath}:${match.line}:${match.text}`
        );
        const relativePath = toWorkspaceRelativePath(
          context.workspaceRoot,
          resolvedPath ?? match.absolutePath
        );
        const truncated = truncateLine(match.text);

        return {
          line: match.line,
          path: relativePath,
          text: truncated.text
        };
      });

    return {
      include: input.include,
      matches: matches.slice(0, MAX_MATCHES),
      path: input.path,
      pattern: input.pattern,
      totalMatches: matches.length,
      truncated: matches.length > MAX_MATCHES
    };
  },
  inputSchema: grepInputSchema,
  name: 'grep',
  present({ output }) {
    if (output.matches.length === 0) {
      return {
        metadata: {
          include: output.include,
          matches: [],
          path: output.path,
          pattern: output.pattern,
          truncated: false
        },
        outputText: 'No matches found.',
        payload: output
      };
    }

    const byFile = new Map<string, GrepMatch[]>();

    for (const match of output.matches) {
      const entries = byFile.get(match.path) ?? [];

      entries.push(match);
      byFile.set(match.path, entries);
    }

    const body = [...byFile.entries()].map(([filePath, matches]) => {
      return [
        `${filePath}:`,
        ...matches.map((match) => `  Line ${match.line}: ${match.text}`)
      ].join('\n');
    });

    const header = output.truncated
      ? `Found ${output.totalMatches} matches (showing first ${output.matches.length})`
      : `Found ${output.totalMatches} matches`;

    return {
      metadata: {
        include: output.include,
        matches: output.matches,
        path: output.path,
        pattern: output.pattern,
        truncated: output.truncated
      },
      outputText: [header, '', ...body].join('\n'),
      payload: output
    };
  }
};
