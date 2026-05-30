import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessagePart } from '@opencode/shared';
import {
  getToolCardHeading,
  getToolCardSummaryText
} from './message-list.helpers';

function createCompletedToolPart(input: {
  metadata?: Record<string, unknown>;
  outputText: string;
  toolName: Extract<MessagePart, { type: 'tool' }>['toolName'];
}): Extract<MessagePart, { type: 'tool' }> {
  return {
    createdAt: '2026-05-29T00:00:00.000Z',
    id: 'part-tool-1',
    messageId: 'message-1',
    modelToolCallId: 'model-tool-1',
    order: 0,
    sessionId: 'session-1',
    state: {
      completedAt: '2026-05-29T00:00:02.000Z',
      input: {},
      metadata: input.metadata,
      outputText: input.outputText,
      startedAt: '2026-05-29T00:00:01.000Z',
      status: 'completed'
    },
    toolCallId: 'tool-call-1',
    toolName: input.toolName,
    type: 'tool',
    updatedAt: '2026-05-29T00:00:02.000Z'
  };
}

test('getToolCardHeading shows Explore Subagent for agent/explore tool parts', () => {
  const part = createCompletedToolPart({
    metadata: { subagentType: 'explore' },
    outputText:
      'subagent_session_id: child-1\nsubagent_type: explore\n\n<explore_result>\nsummary\n</explore_result>',
    toolName: 'agent'
  });

  assert.equal(getToolCardHeading(part), 'Explore Subagent');
});

test('getToolCardSummaryText extracts only explore summary body for agent/explore tool parts', () => {
  const part = createCompletedToolPart({
    metadata: {
      sessionTitle: 'Inspect routing logic (@explore subagent)',
      subagentType: 'explore'
    },
    outputText:
      'subagent_session_id: child-1\nsubagent_type: explore\n\n<explore_result>\nFound router in apps/web/src/router.tsx\n</explore_result>',
    toolName: 'agent'
  });

  assert.equal(
    getToolCardSummaryText(part),
    'Found router in apps/web/src/router.tsx'
  );
});

test('getToolCardSummaryText falls back to raw output text for non-subagent tools', () => {
  const part = createCompletedToolPart({
    outputText: 'read src/index.ts',
    toolName: 'read'
  });

  assert.equal(getToolCardSummaryText(part), 'read src/index.ts');
});
