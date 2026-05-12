import type { MessageRuntimeMetadata, SessionDto } from '@opencode/shared';
import { SYSTEM_PROMPT } from '../prompt.js';
import type { ContextSystemBlock } from './schema.js';

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

export function buildEnvironmentSystemBlock(
  input: Pick<
    SystemContextInput,
    'agentName' | 'model' | 'session' | 'workspaceRoot'
  >
): ContextSystemBlock {
  return {
    source: 'environment',
    text: [
      `You are powered by the model named ${input.model.modelId}. The exact model ID is ${input.model.providerId}/${input.model.modelId}.`,
      'Here is useful information about the environment you are running in:',
      '<env>',
      `  Working directory: ${input.workspaceRoot}`,
      `  Workspace root folder: ${input.workspaceRoot}`,
      `  Session id: ${input.session.id}`,
      `  Agent: ${input.agentName}`,
      '  Is directory a git repo: unknown',
      `  Platform: ${process.platform}`,
      `  Today's date: ${new Date().toDateString()}`,
      '</env>'
    ].join('\n')
  };
}

export function buildRuntimeInstructionBlocks(input: {
  lastUserRuntime?: MessageRuntimeMetadata;
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
      source: 'instruction',
      text: transitionedFromPlan
        ? [
            '<system-reminder>',
            'Your operational mode has changed from plan to build.',
            'You are no longer in read-only mode.',
            'You are permitted to make file changes, run shell commands, and utilize your arsenal of tools as needed.',
            '</system-reminder>'
          ].join('\n')
        : [
            '<system-reminder>',
            `Current operational mode: ${variant}.`,
            isReadOnly
              ? 'You are currently in read-only mode. Prefer inspection, explanation, and planning over file changes or shell commands. Do not make file edits or run shell commands unless the user explicitly asks you to leave planning mode or the runtime changes mode for you.'
              : 'You are permitted to make file changes, run shell commands, and use the available tools as needed. Prefer actually carrying the task through implementation and verification instead of stopping at analysis.',
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
    buildEnvironmentSystemBlock(input),
    ...buildRuntimeInstructionBlocks({
      lastUserRuntime: input.lastUserRuntime,
      previousUserRuntime: input.previousUserRuntime
    })
  ];
}
