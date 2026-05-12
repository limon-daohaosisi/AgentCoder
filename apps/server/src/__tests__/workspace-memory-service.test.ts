import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';
import {
  MAX_PROJECT_MEMORY_CHARS,
  workspaceMemoryService
} from '../services/agent/workspace-memory-service.js';

const { environment } = dbTestContext;

beforeEach(() => {
  resetTestDatabase();
});

test('workspaceMemoryService returns workspace AGENTS.md as project memory block', () => {
  writeFileSync(
    path.join(environment.workspaceRoot, 'AGENTS.md'),
    '# Rules\nUse pnpm test.\n'
  );

  const sources = workspaceMemoryService.listPromptMemorySources(
    environment.workspaceRoot
  );

  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.sourceId, 'workspace_agents');
  assert.equal(sources[0]?.origin, 'AGENTS.md');
  assert.match(sources[0]?.text ?? '', /<project-memory source="AGENTS.md"/);
  assert.match(sources[0]?.text ?? '', /Use pnpm test\./);
  assert.equal(sources[0]?.truncated, false);
});

test('workspaceMemoryService truncates oversized AGENTS.md content', () => {
  writeFileSync(
    path.join(environment.workspaceRoot, 'AGENTS.md'),
    'a'.repeat(MAX_PROJECT_MEMORY_CHARS + 128)
  );

  const [source] = workspaceMemoryService.listPromptMemorySources(
    environment.workspaceRoot
  );

  assert.equal(source?.truncated, true);
  assert.match(source?.text ?? '', /Truncated after 16000 chars\./);
});

test('workspaceMemoryService returns empty when AGENTS.md is missing', () => {
  const sources = workspaceMemoryService.listPromptMemorySources(
    environment.workspaceRoot
  );

  assert.deepEqual(sources, []);
});
