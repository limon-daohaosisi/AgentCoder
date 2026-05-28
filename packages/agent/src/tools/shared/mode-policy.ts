import type { ToolExecutionContext } from '../core.js';

export function assertBuildOnlyToolAllowed(input: {
  context: ToolExecutionContext;
  toolName: 'apply_patch' | 'bash';
}) {
  if (input.context.planContext?.variant === 'plan') {
    throw new Error(
      `${input.toolName} is unavailable in plan mode. Stay read-only except for the current plan file.`
    );
  }
}
