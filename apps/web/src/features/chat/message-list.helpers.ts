import type { MessagePart } from '@opencode/shared';

type ToolPart = Extract<MessagePart, { type: 'tool' }>;

function extractMetadata(part: ToolPart): Record<string, unknown> | undefined {
  return 'metadata' in part.state && part.state.metadata
    ? part.state.metadata
    : undefined;
}

export function isExploreSubagentToolPart(part: ToolPart) {
  const metadata = extractMetadata(part);
  return part.toolName === 'agent' && metadata?.subagentType === 'explore';
}

export function getToolCardHeading(part: ToolPart) {
  if (isExploreSubagentToolPart(part)) {
    return 'Explore Subagent';
  }

  return part.toolName;
}

export function getToolCardSummaryText(part: ToolPart) {
  const outputText =
    part.state.status === 'completed' ? part.state.outputText : '';

  if (!isExploreSubagentToolPart(part) || outputText.length === 0) {
    return outputText;
  }

  const match = outputText.match(
    /<explore_result>\s*([\s\S]*?)\s*<\/explore_result>/u
  );

  if (!match) {
    return outputText;
  }

  return match[1]?.trim() ?? outputText;
}

export function getToolCardMetaLine(part: ToolPart) {
  if (!isExploreSubagentToolPart(part)) {
    return null;
  }

  const metadata = extractMetadata(part);
  const sessionTitle =
    typeof metadata?.sessionTitle === 'string' ? metadata.sessionTitle : '';

  return sessionTitle || 'Read-only code exploration summary';
}
