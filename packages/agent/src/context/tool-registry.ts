import { toolRegistry } from '../tools/index.js';
import type { BuiltContext, ResolvedTool } from './schema.js';

export type ToolResolutionInput = {
  agentName: string;
  context: BuiltContext;
  lastUser: BuiltContext['lastUser'];
  model: { modelId: string; providerId: string };
  sessionId: string;
};

export function resolveTools(input: ToolResolutionInput): ResolvedTool[] {
  const overrides = input.lastUser.runtime?.toolOverrides ?? {};

  return toolRegistry
    .map<ResolvedTool>((definition) => {
      const enabled = overrides[definition.name] ?? true;

      return {
        approval: definition.approval,
        description: definition.description,
        enabled,
        inputSchema: definition.inputSchema,
        name: definition.name,
        source: 'builtin'
      };
    })
    .filter((tool) => tool.enabled);
}
