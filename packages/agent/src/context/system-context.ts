import type { MessageRuntimeMetadata, SessionDto } from '@opencode/shared';
import { SYSTEM_PROMPT } from '../prompt.js';
import type { ContextSystemBlock } from './schema.js';
import { buildSessionStableSystemBlocks } from './session-stable-system-context.js';

export type PlanRuntimeContext = {
  filePath?: string;
};

export type SystemContextInput = {
  agentName: string;
  lastUserRuntime?: MessageRuntimeMetadata;
  previousUserRuntime?: MessageRuntimeMetadata;
  model: { modelId: string; providerId: string };
  session: SessionDto;
  workspaceRoot: string;
};

export function buildCoreSystemBlock(): ContextSystemBlock {
  return {
    source: 'core',
    text: SYSTEM_PROMPT
  };
}

export function buildRuntimeInstructionBlocks(input: {
  lastUserRuntime?: MessageRuntimeMetadata;
  planContext?: PlanRuntimeContext;
  previousUserRuntime?: MessageRuntimeMetadata;
}): ContextSystemBlock[] {
  const blocks: ContextSystemBlock[] = [];

  if (input.lastUserRuntime?.variant) {
    const variant = input.lastUserRuntime.variant;
    const isReadOnly = variant === 'plan';
    const previousVariant = input.previousUserRuntime?.variant;
    const transitionedFromPlan =
      previousVariant === 'plan' && variant === 'build';

    blocks.push({
      source: 'mode_rules',
      text: transitionedFromPlan
        ? [
            '<system-reminder>',
            'You are in build mode.',
            'You may now modify workspace files, run shell commands, and use the available tools as needed.',
            'Read the approved current plan file before implementing whenever planning context is relevant.',
            'Prefer carrying the task through implementation and verification instead of stopping at analysis.',
            '</system-reminder>'
          ].join('\n')
        : [
            '<system-reminder>',
            `Current operational mode: ${variant}.`,
            isReadOnly
              ? [
                  'You are currently in planning mode.',
                  'You must not modify workspace code or run shell commands.',
                  'In plan mode, only the current plan file may be written or edited.',
                  'First form a complete plan, then create or refine tasks so they stay aligned with that plan.'
                ].join(' ')
              : [
                  'You may modify workspace files, run shell commands, and use the available tools as needed.',
                  'Read the approved current plan file before implementing whenever planning context is relevant.',
                  'Prefer carrying the task through implementation and verification instead of stopping at analysis.'
                ].join(' '),
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
      text: [
        'You must respond with JSON matching this schema exactly:',
        '',
        JSON.stringify(input.lastUserRuntime.format.schema),
        '',
        'Do not wrap the JSON in Markdown fences.',
        'Do not add explanatory text before or after the JSON.'
      ].join('\n')
    });
  }

  return blocks;
}

export function buildSystemContext(
  input: SystemContextInput
): ContextSystemBlock[] {
  return [
    buildCoreSystemBlock(),
    ...buildSessionStableSystemBlocks({
      agentName: input.agentName,
      model: input.model,
      workspaceRoot: input.workspaceRoot
    }),
    ...buildRuntimeInstructionBlocks({
      lastUserRuntime: input.lastUserRuntime,
      previousUserRuntime: input.previousUserRuntime
    })
  ];
}
