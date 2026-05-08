import { jsonSchema, tool, type ToolSet } from 'ai';
import type { ResolvedTool, ResolvedToolPolicyMap } from './schema.js';

export function toToolPolicies(tools: ResolvedTool[]): ResolvedToolPolicyMap {
  return Object.fromEntries(
    tools.map((item) => [
      item.name,
      {
        approval: item.approval,
        enabled: item.enabled,
        name: item.name,
        source: item.source
      }
    ])
  );
}

export function toAiSdkToolSet(input: {
  executionMode: 'manual';
  tools: ResolvedTool[];
}): ToolSet {
  return Object.fromEntries(
    input.tools.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(definition.inputSchema),
        strict: true
      })
    ])
  ) as ToolSet;
}
