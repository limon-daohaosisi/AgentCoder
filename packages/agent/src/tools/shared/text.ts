export function countMatches(content: string, needle: string) {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let index = 0;

  while (true) {
    const nextIndex = content.indexOf(needle, index);

    if (nextIndex === -1) {
      return count;
    }

    count += 1;
    index = nextIndex + needle.length;
  }
}

export function detectLineEnding(content: string) {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

export function normalizeForLineEnding(
  content: string,
  lineEnding: '\n' | '\r\n'
) {
  return lineEnding === '\r\n'
    ? content.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')
    : content.replaceAll('\r\n', '\n');
}

export function countTextLines(content: string) {
  return content
    .replaceAll('\r\n', '\n')
    .split('\n')
    .filter(
      (_, index, lines) => !(index === lines.length - 1 && lines[index] === '')
    ).length;
}
