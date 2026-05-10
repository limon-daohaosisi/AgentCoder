import type { ToolExecutionContext } from '../core.js';
import { toWorkspaceRelativePath } from './path.js';

export type ToolDiagnostic = {
  column: number;
  filePath: string;
  line: number;
  message: string;
  severity: 'error' | 'info' | 'warning';
};

export type DiagnosticsProvider = {
  collectForFiles(paths: string[]): Promise<ToolDiagnostic[]>;
};

function groupDiagnostics(diagnostics: ToolDiagnostic[]) {
  const grouped = new Map<string, ToolDiagnostic[]>();

  for (const item of diagnostics) {
    const entries = grouped.get(item.filePath) ?? [];

    entries.push(item);
    grouped.set(item.filePath, entries);
  }

  return grouped;
}

export function formatDiagnosticsText(input: {
  context: ToolExecutionContext;
  diagnostics: ToolDiagnostic[];
}): string {
  if (input.diagnostics.length === 0) {
    return '';
  }

  const grouped = groupDiagnostics(input.diagnostics);
  const blocks = [...grouped.entries()].map(([absolutePath, entries]) => {
    const relativePath = toWorkspaceRelativePath(
      input.context.workspaceRoot,
      absolutePath
    );

    return [
      `<diagnostics file="${relativePath}">`,
      ...entries.map(
        (item) =>
          `${item.severity.toUpperCase()} ${item.line}:${item.column} ${item.message}`
      ),
      '</diagnostics>'
    ].join('\n');
  });

  return blocks.join('\n\n');
}
