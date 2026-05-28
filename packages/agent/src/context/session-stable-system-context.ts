import type { ContextSystemBlock } from './schema.js';

export function buildSessionStableSystemBlocks(input: {
  agentName: string;
  model: { modelId: string; providerId: string };
  workspaceRoot: string;
}): ContextSystemBlock[] {
  return [
    {
      source: 'instruction',
      text: [
        'Runtime environment:',
        `- Model: ${input.model.providerId}/${input.model.modelId}`,
        `- Working directory: ${input.workspaceRoot}`,
        `- Agent: ${input.agentName}`,
        `- Platform: ${process.platform}`
      ].join('\n')
    }
  ];
}
