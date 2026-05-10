export type PatchHunk =
  | { contents: string; path: string; type: 'add' }
  | { path: string; type: 'delete' }
  | {
      chunks: UpdateFileChunk[];
      movePath?: string;
      path: string;
      type: 'update';
    };

export type UpdateFileChunk = {
  changeContext?: string;
  isEndOfFile?: boolean;
  newLines: string[];
  oldLines: string[];
};

function parsePatchHeader(
  lines: string[],
  startIndex: number
): { filePath: string; movePath?: string; nextIndex: number } | null {
  const line = lines[startIndex];

  if (!line) {
    return null;
  }

  if (line.startsWith('*** Add File:')) {
    const filePath = line.slice('*** Add File:'.length).trim();

    return filePath ? { filePath, nextIndex: startIndex + 1 } : null;
  }

  if (line.startsWith('*** Delete File:')) {
    const filePath = line.slice('*** Delete File:'.length).trim();

    return filePath ? { filePath, nextIndex: startIndex + 1 } : null;
  }

  if (line.startsWith('*** Update File:')) {
    const filePath = line.slice('*** Update File:'.length).trim();
    let movePath: string | undefined;
    let nextIndex = startIndex + 1;

    const nextLine = lines[nextIndex];

    if (nextLine?.startsWith('*** Move to:')) {
      movePath = nextLine.slice('*** Move to:'.length).trim();
      nextIndex += 1;
    }

    return filePath ? { filePath, movePath, nextIndex } : null;
  }

  return null;
}

function parseUpdateFileChunks(lines: string[], startIndex: number) {
  const chunks: UpdateFileChunk[] = [];
  let index = startIndex;

  while (index < lines.length && !lines[index]?.startsWith('***')) {
    const currentLine = lines[index];

    if (currentLine?.startsWith('@@')) {
      const contextLine = currentLine.slice(2).trim();

      index += 1;

      const oldLines: string[] = [];
      const newLines: string[] = [];
      let isEndOfFile = false;

      while (
        index < lines.length &&
        !lines[index]?.startsWith('@@') &&
        !lines[index]?.startsWith('***')
      ) {
        const changeLine = lines[index] ?? '';

        if (changeLine === '*** End of File') {
          isEndOfFile = true;
          index += 1;
          break;
        }

        if (changeLine.startsWith(' ')) {
          const content = changeLine.slice(1);

          oldLines.push(content);
          newLines.push(content);
        } else if (changeLine.startsWith('-')) {
          oldLines.push(changeLine.slice(1));
        } else if (changeLine.startsWith('+')) {
          newLines.push(changeLine.slice(1));
        }

        index += 1;
      }

      chunks.push({
        changeContext: contextLine || undefined,
        isEndOfFile: isEndOfFile || undefined,
        newLines,
        oldLines
      });
      continue;
    }

    index += 1;
  }

  return { chunks, nextIndex: index };
}

function parseAddFileContents(lines: string[], startIndex: number) {
  let content = '';
  let index = startIndex;

  while (index < lines.length && !lines[index]?.startsWith('***')) {
    const line = lines[index];

    if (line?.startsWith('+')) {
      content += `${line.slice(1)}\n`;
    }

    index += 1;
  }

  if (content.endsWith('\n')) {
    content = content.slice(0, -1);
  }

  return { content, nextIndex: index };
}

function stripHeredoc(input: string): string {
  const heredocMatch = input.match(
    /^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/u
  );

  return heredocMatch?.[2] ?? input;
}

function normalizeUnicode(input: string) {
  return input
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ');
}

type Comparator = (left: string, right: string) => boolean;

function tryMatch(
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: Comparator,
  eof: boolean
) {
  if (eof) {
    const fromEnd = lines.length - pattern.length;

    if (fromEnd >= startIndex) {
      let matches = true;

      for (let index = 0; index < pattern.length; index += 1) {
        if (!compare(lines[fromEnd + index] ?? '', pattern[index] ?? '')) {
          matches = false;
          break;
        }
      }

      if (matches) {
        return fromEnd;
      }
    }
  }

  for (
    let outer = startIndex;
    outer <= lines.length - pattern.length;
    outer += 1
  ) {
    let matches = true;

    for (let inner = 0; inner < pattern.length; inner += 1) {
      if (!compare(lines[outer + inner] ?? '', pattern[inner] ?? '')) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return outer;
    }
  }

  return -1;
}

function seekSequence(
  lines: string[],
  pattern: string[],
  startIndex: number,
  eof = false
) {
  if (pattern.length === 0) {
    return -1;
  }

  const exact = tryMatch(
    lines,
    pattern,
    startIndex,
    (left, right) => left === right,
    eof
  );

  if (exact !== -1) {
    return exact;
  }

  const rstrip = tryMatch(
    lines,
    pattern,
    startIndex,
    (left, right) => left.trimEnd() === right.trimEnd(),
    eof
  );

  if (rstrip !== -1) {
    return rstrip;
  }

  const trim = tryMatch(
    lines,
    pattern,
    startIndex,
    (left, right) => left.trim() === right.trim(),
    eof
  );

  if (trim !== -1) {
    return trim;
  }

  return tryMatch(
    lines,
    pattern,
    startIndex,
    (left, right) =>
      normalizeUnicode(left.trim()) === normalizeUnicode(right.trim()),
    eof
  );
}

function computeReplacements(
  originalLines: string[],
  filePath: string,
  chunks: UpdateFileChunk[]
) {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const contextIndex = seekSequence(
        originalLines,
        [chunk.changeContext],
        lineIndex
      );

      if (contextIndex === -1) {
        throw new Error(
          `Failed to find context '${chunk.changeContext}' in ${filePath}`
        );
      }

      lineIndex = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIndex =
        originalLines.length > 0 &&
        originalLines[originalLines.length - 1] === ''
          ? originalLines.length - 1
          : originalLines.length;

      replacements.push([insertionIndex, 0, chunk.newLines]);
      continue;
    }

    let pattern = chunk.oldLines;
    let replacement = chunk.newLines;
    let found = seekSequence(
      originalLines,
      pattern,
      lineIndex,
      chunk.isEndOfFile
    );

    if (found === -1 && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1);
      replacement =
        replacement[replacement.length - 1] === ''
          ? replacement.slice(0, -1)
          : replacement;
      found = seekSequence(
        originalLines,
        pattern,
        lineIndex,
        chunk.isEndOfFile
      );
    }

    if (found === -1) {
      throw new Error(
        `Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join('\n')}`
      );
    }

    replacements.push([found, pattern.length, replacement]);
    lineIndex = found + pattern.length;
  }

  replacements.sort((left, right) => left[0] - right[0]);

  return replacements;
}

function applyReplacements(
  lines: string[],
  replacements: Array<[number, number, string[]]>
) {
  const next = [...lines];

  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];

    if (!replacement) {
      continue;
    }

    const [startIndex, oldLength, newSegment] = replacement;

    next.splice(startIndex, oldLength, ...newSegment);
  }

  return next;
}

export function parsePatch(patchText: string): { hunks: PatchHunk[] } {
  const cleaned = stripHeredoc(patchText.trim());
  const lines = cleaned.split('\n');
  const beginIndex = lines.findIndex(
    (line) => line.trim() === '*** Begin Patch'
  );
  const endIndex = lines.findIndex((line) => line.trim() === '*** End Patch');

  if (beginIndex === -1 || endIndex === -1 || beginIndex >= endIndex) {
    throw new Error('Invalid patch format: missing Begin/End markers');
  }

  const hunks: PatchHunk[] = [];
  let index = beginIndex + 1;

  while (index < endIndex) {
    const header = parsePatchHeader(lines, index);

    if (!header) {
      index += 1;
      continue;
    }

    const line = lines[index] ?? '';

    if (line.startsWith('*** Add File:')) {
      const { content, nextIndex } = parseAddFileContents(
        lines,
        header.nextIndex
      );

      hunks.push({
        contents: content,
        path: header.filePath,
        type: 'add'
      });
      index = nextIndex;
      continue;
    }

    if (line.startsWith('*** Delete File:')) {
      hunks.push({ path: header.filePath, type: 'delete' });
      index = header.nextIndex;
      continue;
    }

    if (line.startsWith('*** Update File:')) {
      const { chunks, nextIndex } = parseUpdateFileChunks(
        lines,
        header.nextIndex
      );

      hunks.push({
        chunks,
        movePath: header.movePath,
        path: header.filePath,
        type: 'update'
      });
      index = nextIndex;
      continue;
    }

    index += 1;
  }

  return { hunks };
}

export function deriveUpdatedContent(input: {
  content: string;
  filePath: string;
  chunks: UpdateFileChunk[];
}) {
  const originalLines = input.content.split('\n');

  if (
    originalLines.length > 0 &&
    originalLines[originalLines.length - 1] === ''
  ) {
    originalLines.pop();
  }

  const replacements = computeReplacements(
    originalLines,
    input.filePath,
    input.chunks
  );
  const nextLines = applyReplacements(originalLines, replacements);

  if (nextLines.length === 0 || nextLines[nextLines.length - 1] !== '') {
    nextLines.push('');
  }

  return nextLines.join('\n');
}
