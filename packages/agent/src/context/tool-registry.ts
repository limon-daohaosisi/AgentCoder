import type { SessionVariant } from '@opencode/shared';
import { toolRegistry } from '../tools/index.js';
import { getBuiltinSubagentDefinition } from '../subagents/builtin.js';
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
  const subagent = getBuiltinSubagentDefinition(input.agentName);
  const allowedTools = subagent ? new Set(subagent.allowedTools) : null;

  return toolRegistry
    .map<ResolvedTool>((definition) => {
      const override = overrides[definition.name];
      const allowedByAgent = allowedTools
        ? allowedTools.has(definition.name)
        : true;
      const enabled = allowedByAgent && (override ?? true);

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
