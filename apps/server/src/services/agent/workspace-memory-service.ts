import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { PromptMemorySource } from '@opencode/agent';

const PROJECT_MEMORY_FILENAME = 'AGENTS.md';
const MAX_PROJECT_MEMORY_CHARS = 16_000;

function truncateProjectMemory(text: string) {
  if (text.length <= MAX_PROJECT_MEMORY_CHARS) {
    return { text, truncated: false };
  }

  return {
    text: `${text.slice(0, MAX_PROJECT_MEMORY_CHARS)}\n\n[Truncated after ${MAX_PROJECT_MEMORY_CHARS} chars.]`,
    truncated: true
  };
}

function toProjectMemoryBlock(input: { relativePath: string; text: string }) {
  return [
    `<project-memory source="AGENTS.md" path="${input.relativePath}">`,
    input.text,
    '</project-memory>'
  ].join('\n');
}

export const workspaceMemoryService = {
  listPromptMemorySources(workspaceRoot: string): PromptMemorySource[] {
    const memoryPath = path.join(workspaceRoot, PROJECT_MEMORY_FILENAME);

    if (!existsSync(memoryPath)) {
      return [];
    }

    try {
      const raw = readFileSync(memoryPath, 'utf8');
      const relativePath = PROJECT_MEMORY_FILENAME;
      const truncated = truncateProjectMemory(raw);

      return [
        {
          origin: relativePath,
          sourceId: 'workspace_agents',
          text: toProjectMemoryBlock({
            relativePath,
            text: truncated.text
          }),
          truncated: truncated.truncated
        }
      ];
    } catch (error) {
      console.error('Failed to read workspace AGENTS.md prompt memory:', error);
      return [];
    }
  }
};

export { MAX_PROJECT_MEMORY_CHARS };
