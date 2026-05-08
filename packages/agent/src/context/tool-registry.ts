import { toolRegistry } from '../tools/index.js';
import { toolRequiresApproval } from '../tool-executor.js';
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
        approval: toolRequiresApproval(definition.name) ? 'required' : 'never',
        description: definition.description,
        enabled,
        inputSchema: definition.inputSchema,
        name: definition.name,
        source: 'builtin'
      };
    })
    .filter((tool) => tool.enabled);
}
