import type { SessionVariant } from '@opencode/shared';
import { toolRegistry } from '../tools/index.js';
import { taskUpdateExecutionOnlyInputSchema } from '../tools/task_update/index.js';
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
  const variant = input.lastUser.runtime?.variant;

  return toolRegistry
    .map<ResolvedTool>((definition) => {
      const override = overrides[definition.name];
      const enabled = override ?? true;

      return {
        approval: definition.approval,
        description: definition.description,
        enabled,
        inputSchema:
          definition.name === 'task_update' && variant === 'build'
            ? taskUpdateExecutionOnlyInputSchema
            : definition.inputSchema,
        name: definition.name,
        source: 'builtin'
      };
    })
    .filter((tool) => tool.enabled);
}
