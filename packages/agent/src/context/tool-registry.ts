import type { SessionVariant, ToolName } from '@opencode/shared';
import { toolRegistry } from '../tools/index.js';
import { taskUpdateExecutionOnlyInputSchema } from '../tools/task_update/index.js';
import type { BuiltContext, ResolvedTool } from './schema.js';

const planAllowedTools = new Set<ToolName>([
  'read',
  'glob',
  'grep',
  'task_create',
  'task_list',
  'task_get',
  'task_update',
  'task_stop',
  'write',
  'edit',
  'plan_exit'
]);

export type ToolResolutionInput = {
  agentName: string;
  context: BuiltContext;
  lastUser: BuiltContext['lastUser'];
  model: { modelId: string; providerId: string };
  sessionId: string;
};

function isToolAllowedInVariant(name: ToolName, variant?: SessionVariant) {
  if (variant === 'plan') {
    return planAllowedTools.has(name);
  }

  if (variant === 'build' && name === 'task_create') {
    return false;
  }

  if (variant === 'build' && name === 'plan_exit') {
    return false;
  }

  return true;
}

export function resolveTools(input: ToolResolutionInput): ResolvedTool[] {
  const overrides = input.lastUser.runtime?.toolOverrides ?? {};
  const variant = input.lastUser.runtime?.variant;

  return toolRegistry
    .map<ResolvedTool>((definition) => {
      const allowedByVariant = isToolAllowedInVariant(definition.name, variant);
      const override = overrides[definition.name];
      const enabled = allowedByVariant && (override ?? true);

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
