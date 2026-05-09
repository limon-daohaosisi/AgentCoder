import { createTwoFilesPatch, diffLines } from 'diff';

export type FileDiff = {
  additions: number;
  deletions: number;
  diff: string;
};

function normalizeDiffContent(content: string) {
  return content.replaceAll('\r\n', '\n');
}

export function trimDiff(diff: string): string {
  const lines = diff.split('\n');
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) &&
      !line.startsWith('---') &&
      !line.startsWith('+++')
  );

  if (contentLines.length === 0) {
    return diff;
  }

  let minIndent = Number.POSITIVE_INFINITY;

  for (const line of contentLines) {
    const content = line.slice(1);

    if (!content.trim()) {
      continue;
    }

    const match = content.match(/^(\s*)/u);

    if (match) {
      minIndent = Math.min(minIndent, (match[1] ?? '').length);
    }
  }

  if (!Number.isFinite(minIndent) || minIndent === 0) {
    return diff;
  }

  return lines
    .map((line) => {
      if (
        (line.startsWith('+') ||
          line.startsWith('-') ||
          line.startsWith(' ')) &&
        !line.startsWith('---') &&
        !line.startsWith('+++')
      ) {
        return `${line[0]}${line.slice(1 + minIndent)}`;
      }

      return line;
    })
    .join('\n');
}

export function createFileDiff(input: {
  filePath: string;
  nextContent: string;
  nextFilePath?: string;
  previousContent: string;
  previousFilePath?: string;
}): FileDiff {
  if (input.previousContent === input.nextContent) {
    return { additions: 0, deletions: 0, diff: 'No changes' };
  }

  const previousContent = normalizeDiffContent(input.previousContent);
  const nextContent = normalizeDiffContent(input.nextContent);
  const diff = trimDiff(
    createTwoFilesPatch(
      input.previousFilePath ?? input.filePath,
      input.nextFilePath ?? input.filePath,
      previousContent,
      nextContent
    )
  );
  let additions = 0;
  let deletions = 0;

  for (const change of diffLines(previousContent, nextContent)) {
    if (change.added) {
      additions += change.count ?? 0;
    }

    if (change.removed) {
      deletions += change.count ?? 0;
    }
  }

  return { additions, deletions, diff };
}

export function createUnifiedDiff(
  previousContent: string,
  nextContent: string,
  filePath = 'file'
) {
  return createFileDiff({
    filePath,
    nextContent,
    previousContent
  }).diff;
}
