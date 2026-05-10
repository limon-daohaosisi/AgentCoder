import type { MessageRuntimeMetadata, SessionDto } from '@opencode/shared';
import { SYSTEM_PROMPT } from '../prompt.js';
import type { ContextSystemBlock } from './schema.js';

export type SystemContextInput = {
  agentName: string;
  lastUserRuntime?: MessageRuntimeMetadata;
  model: { modelId: string; providerId: string };
  session: SessionDto;
  workspaceRoot: string;
};

export function buildSystemContext(
  input: SystemContextInput
): ContextSystemBlock[] {
  const blocks: ContextSystemBlock[] = [
    {
      source: 'core',
      text: SYSTEM_PROMPT
    },
    {
      source: 'environment',
      text: [
        `Workspace root: ${input.workspaceRoot}`,
        `Session id: ${input.session.id}`,
        `Agent: ${input.agentName}`,
        `Model: ${input.model.providerId}/${input.model.modelId}`
      ].join('\n')
    }
  ];

  if (input.lastUserRuntime?.variant) {
    const variant = input.lastUserRuntime.variant;
    const isReadOnly = variant === 'plan';

    blocks.push({
      source: 'instruction',
      text: [
        '<system-reminder>',
        `Current operational mode: ${variant}.`,
        isReadOnly
          ? 'You are currently in read-only mode. Prefer inspection and planning over file changes or shell commands.'
          : 'You are permitted to make file changes, run shell commands, and use the available tools as needed.',
        '</system-reminder>'
      ].join('\n')
    });
  }

  if (input.lastUserRuntime?.userSystem) {
    blocks.push({
      source: 'user_system',
      text: input.lastUserRuntime.userSystem
    });
  }

  if (input.lastUserRuntime?.format?.type === 'json_schema') {
    blocks.push({
      source: 'format',
      text: `Respond with JSON matching this schema: ${JSON.stringify(
        input.lastUserRuntime.format.schema
      )}`
    });
  }

  return blocks;
}
