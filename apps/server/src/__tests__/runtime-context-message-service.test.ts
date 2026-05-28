import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';
import { runtimeContextMessageService } from '../services/agent/runtime-context-message-service.js';

const { environment, messageService, sessionService, workspaceService } =
  dbTestContext;

function createSession() {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });

  return sessionService.createSession({
    goalText: 'Persist durable runtime context messages',
    workspaceId: workspace.id
  });
}

beforeEach(() => {
  resetTestDatabase();
});

test('runtimeContextMessageService persists a durable runtime_context user message', () => {
  const session = createSession();

  const message = runtimeContextMessageService.persistRuntimeContextMessage({
    key: 'mode_transition:build',
    parts: [
      {
        kind: 'mode_transition',
        metadata: { variant: 'build' },
        text: 'The session has moved from plan mode to build mode.'
      }
    ],
    sessionId: session.id,
    variant: 'build'
  });

  assert.equal(message.role, 'user');
  assert.equal(message.runtime?.runtimeContextInjected, true);
  assert.equal(message.content.length, 1);
  assert.equal(message.content[0]?.type, 'runtime_context');
  assert.equal(
    message.content[0]?.type === 'runtime_context'
      ? message.content[0].kind
      : undefined,
    'mode_transition'
  );

  const stored = messageService.listMessages(session.id);

  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.content[0]?.type, 'runtime_context');
});

test('runtimeContextMessageService dedups by runtime context key', () => {
  const session = createSession();

  const first = runtimeContextMessageService.persistRuntimeContextMessage({
    key: 'nested_agents_memory:packages/agent/AGENTS.md',
    parts: [
      {
        kind: 'nested_agents_memory',
        metadata: { path: 'packages/agent/AGENTS.md' },
        text: '<project-memory source="AGENTS.md" path="packages/agent/AGENTS.md">A</project-memory>'
      }
    ],
    sessionId: session.id,
    variant: 'plan'
  });
  const second = runtimeContextMessageService.persistRuntimeContextMessage({
    key: 'nested_agents_memory:packages/agent/AGENTS.md',
    parts: [
      {
        kind: 'nested_agents_memory',
        metadata: { path: 'packages/agent/AGENTS.md' },
        text: '<project-memory source="AGENTS.md" path="packages/agent/AGENTS.md">A</project-memory>'
      }
    ],
    sessionId: session.id,
    variant: 'plan'
  });

  assert.equal(first.id, second.id);
  assert.equal(messageService.listMessages(session.id).length, 1);
});

test('runtimeContextMessageService creates a new message when the key changes', () => {
  const session = createSession();

  runtimeContextMessageService.persistRuntimeContextMessage({
    key: 'plan_file:plan-1:.mycoding/plans/plan-1.md',
    parts: [
      {
        kind: 'plan_file',
        metadata: { filePath: '.mycoding/plans/plan-1.md', planId: 'plan-1' },
        text: 'Current plan file path: .mycoding/plans/plan-1.md'
      }
    ],
    sessionId: session.id,
    variant: 'plan'
  });
  runtimeContextMessageService.persistRuntimeContextMessage({
    key: 'plan_file:plan-2:.mycoding/plans/plan-2.md',
    parts: [
      {
        kind: 'plan_file',
        metadata: { filePath: '.mycoding/plans/plan-2.md', planId: 'plan-2' },
        text: 'Current plan file path: .mycoding/plans/plan-2.md'
      }
    ],
    sessionId: session.id,
    variant: 'plan'
  });

  assert.equal(messageService.listMessages(session.id).length, 2);
});
