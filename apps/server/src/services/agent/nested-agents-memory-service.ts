import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeContextSource } from '@opencode/agent';

const PROJECT_MEMORY_FILENAME = 'AGENTS.md';
const MAX_NESTED_PROJECT_MEMORY_CHARS = 12_000;

type SessionMemoryState = {
  loadedMemoryPaths: Set<string>;
  triggers: Set<string>;
};

const stateBySessionId = new Map<string, SessionMemoryState>();

function getOrCreateState(sessionId: string): SessionMemoryState {
  let state = stateBySessionId.get(sessionId);

  if (!state) {
    state = {
      loadedMemoryPaths: new Set<string>(),
      triggers: new Set<string>()
    };
    stateBySessionId.set(sessionId, state);
  }

  return state;
}

function toPosixRelative(workspaceRoot: string, absolutePath: string) {
  return path
    .relative(workspaceRoot, absolutePath)
    .split(path.sep)
    .join(path.posix.sep);
}

function truncateNestedMemory(text: string) {
  if (text.length <= MAX_NESTED_PROJECT_MEMORY_CHARS) {
    return { text, truncated: false };
  }

  return {
    text: `${text.slice(0, MAX_NESTED_PROJECT_MEMORY_CHARS)}\n\n[Truncated after ${MAX_NESTED_PROJECT_MEMORY_CHARS} chars.]`,
    truncated: true
  };
}

function listCandidateDirectories(input: {
  targetRelativePath: string;
  workspaceRoot: string;
}) {
  const targetDirectory = path.dirname(input.targetRelativePath);

  if (
    targetDirectory === '.' ||
    targetDirectory === '' ||
    targetDirectory.startsWith('..')
  ) {
    return [];
  }

  const segments = targetDirectory
    .split(path.posix.sep)
    .filter((segment) => segment.length > 0);
  const directories: string[] = [];

  for (let index = 0; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index + 1).join(path.posix.sep));
  }

  return directories.map((relativeDirectory) =>
    path.join(input.workspaceRoot, relativeDirectory)
  );
}

function toNestedMemorySource(input: {
  absolutePath: string;
  relativePath: string;
  text: string;
  truncated: boolean;
}): RuntimeContextSource {
  return {
    kind: 'nested_agents_memory',
    metadata: {
      path: input.relativePath,
      truncated: input.truncated
    },
    sourceId: `nested_agents:${input.relativePath}`,
    text: [
      `<project-memory source="AGENTS.md" path="${input.relativePath}">`,
      input.text,
      '</project-memory>'
    ].join('\n')
  };
}

export const nestedAgentsMemoryService = {
  clearSession(sessionId: string) {
    stateBySessionId.delete(sessionId);
  },

  clearTriggers(sessionId: string) {
    getOrCreateState(sessionId).triggers.clear();
  },

  registerReadTarget(input: { filePath: string; sessionId: string }) {
    getOrCreateState(input.sessionId).triggers.add(input.filePath);
  },

  consumeRuntimeSources(input: {
    sessionId: string;
    workspaceRoot: string;
  }): RuntimeContextSource[] {
    const state = getOrCreateState(input.sessionId);
    const sources: RuntimeContextSource[] = [];

    for (const triggerPath of state.triggers) {
      const absoluteTriggerPath = path.join(input.workspaceRoot, triggerPath);
      const candidateDirectories = listCandidateDirectories({
        targetRelativePath: triggerPath,
        workspaceRoot: input.workspaceRoot
      });

      for (const directory of candidateDirectories) {
        const memoryPath = path.join(directory, PROJECT_MEMORY_FILENAME);

        if (!existsSync(memoryPath)) {
          continue;
        }

        const relativeMemoryPath = toPosixRelative(
          input.workspaceRoot,
          memoryPath
        );

        if (
          relativeMemoryPath === PROJECT_MEMORY_FILENAME ||
          state.loadedMemoryPaths.has(relativeMemoryPath)
        ) {
          continue;
        }

        const raw = readFileSync(memoryPath, 'utf8');
        const truncated = truncateNestedMemory(raw);

        sources.push(
          toNestedMemorySource({
            absolutePath: memoryPath,
            relativePath: relativeMemoryPath,
            text: truncated.text,
            truncated: truncated.truncated
          })
        );
        state.loadedMemoryPaths.add(relativeMemoryPath);
      }

      if (!absoluteTriggerPath.startsWith(input.workspaceRoot)) {
        continue;
      }
    }

    state.triggers.clear();
    return sources;
  }
};
