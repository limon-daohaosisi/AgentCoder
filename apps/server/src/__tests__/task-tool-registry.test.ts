import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTools } from '@opencode/agent';

function createInput(variant: 'build' | 'plan') {
  const runtime: {
    format: { type: 'text' };
    toolOverrides?: Partial<Record<string, boolean>>;
    variant: 'build' | 'plan';
  } = { format: { type: 'text' as const }, variant };

  return {
    agentName: 'default',
    context: {
      debug: { promptSources: [], skippedParts: [] },
      estimate: { chars: 0, tokens: 0 },
      lastUser: {
        agentName: 'default',
        messageId: 'message-1',
        model: { modelId: 'gpt-4.1-mini', providerId: 'openai' },
        runtime
      },
      messages: [],
      system: []
    },
    lastUser: {
      agentName: 'default',
      messageId: 'message-1',
      model: { modelId: 'gpt-4.1-mini', providerId: 'openai' },
      runtime
    },
    model: { modelId: 'gpt-4.1-mini', providerId: 'openai' },
    sessionId: 'session-1'
  };
}

test('resolveTools exposes task management tools in plan mode', () => {
  const tools = resolveTools(createInput('plan')).map((tool) => tool.name);

  assert.ok(tools.includes('task_create'));
  assert.ok(tools.includes('task_list'));
  assert.ok(tools.includes('task_get'));
  assert.ok(tools.includes('task_update'));
  assert.ok(tools.includes('task_stop'));
  assert.ok(tools.includes('write'));
  assert.ok(tools.includes('edit'));
  assert.ok(tools.includes('plan_exit'));
  assert.ok(tools.includes('bash'));
  assert.ok(tools.includes('apply_patch'));
});

test('resolveTools keeps full tool visibility in build mode', () => {
  const tools = resolveTools(createInput('build')).map((tool) => tool.name);

  assert.ok(tools.includes('task_create'));
  assert.ok(tools.includes('plan_exit'));
  assert.ok(tools.includes('task_list'));
  assert.ok(tools.includes('task_get'));
  assert.ok(tools.includes('task_update'));
  assert.ok(tools.includes('task_stop'));
  assert.ok(tools.includes('bash'));
  assert.ok(tools.includes('apply_patch'));
});

test('resolveTools exposes execution-only task_update schema in build mode', () => {
  const taskUpdate = resolveTools(createInput('build')).find(
    (tool) => tool.name === 'task_update'
  );

  assert.ok(taskUpdate);

  const parsed = taskUpdate!.inputSchema.safeParse({
    taskId: 'task-1',
    status: 'running'
  });
  assert.equal(parsed.success, true);

  const structureMutation = taskUpdate!.inputSchema.safeParse({
    description: 'should be rejected by build schema',
    taskId: 'task-1'
  });
  assert.equal(structureMutation.success, false);
});

test('resolveTools restricts explore agent to read-only exploration tools', () => {
  const input = createInput('build');
  input.agentName = 'explore';
  input.context.lastUser.agentName = 'explore';
  input.lastUser.agentName = 'explore';

  const tools = resolveTools(input)
    .map((tool) => tool.name)
    .sort();

  assert.deepEqual(tools, ['batch', 'glob', 'grep', 'read']);
});

test('resolveTools only lets explore toolOverrides shrink visibility', () => {
  const input = createInput('build');
  input.agentName = 'explore';
  input.context.lastUser.agentName = 'explore';
  input.lastUser.agentName = 'explore';
  input.context.lastUser.runtime = {
    format: { type: 'text' },
    toolOverrides: {
      apply_patch: true,
      grep: false
    },
    variant: 'build'
  };
  input.lastUser.runtime = input.context.lastUser.runtime;

  const tools = resolveTools(input)
    .map((tool) => tool.name)
    .sort();

  assert.deepEqual(tools, ['batch', 'glob', 'read']);
});
