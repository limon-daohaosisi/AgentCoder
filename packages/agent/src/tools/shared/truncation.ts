const DEFAULT_MAX_LINE_LENGTH = 2_000;
const DEFAULT_MAX_TOOL_TEXT_CHARS = 30_000;

export type TextTruncationResult = {
  text: string;
  truncated: boolean;
};

export function truncateLine(
  line: string,
  maxLength = DEFAULT_MAX_LINE_LENGTH
): TextTruncationResult {
  if (line.length <= maxLength) {
    return { text: line, truncated: false };
  }

  return {
    text: `${line.slice(0, maxLength)}... [truncated]`,
    truncated: true
  };
}

export function truncateText(
  text: string,
  maxChars = DEFAULT_MAX_TOOL_TEXT_CHARS
): TextTruncationResult {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  return {
    text: `${text.slice(0, maxChars)}\n... [truncated]`,
    truncated: true
  };
}

export function formatNumberedLines(lines: string[], offset: number) {
  let truncated = false;

  const text = lines
    .map((line, index) => {
      const lineResult = truncateLine(line);

      if (lineResult.truncated) {
        truncated = true;
      }

      return `${offset + index}: ${lineResult.text}`;
    })
    .join('\n');

  return { text, truncated };
}
