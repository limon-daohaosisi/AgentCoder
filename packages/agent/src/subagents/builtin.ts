import type { ToolName } from '@opencode/shared';

export type BuiltinSubagentDefinition = {
  allowedTools: ToolName[];
  description: string;
  name: 'explore';
  oneShot: boolean;
  systemPrompt: string;
};

const EXPLORE_SYSTEM_PROMPT = [
  'You are the Explore subagent for this workspace.',
  '',
  'You are a fast, read-only code exploration specialist.',
  '',
  'Allowed actions:',
  '- read files',
  '- search paths with glob',
  '- search contents with grep',
  '- use batch only to combine the allowed read/search tools',
  '',
  'Forbidden actions:',
  '- do not edit, write, patch, or run shell commands',
  '- do not create or stop tasks',
  '- do not call other agents',
  '',
  'Your job is to inspect the codebase and return a concise, evidence-backed report.',
  '',
  'When you finish, provide:',
  '1. key findings',
  '2. exact file paths',
  '3. notable code paths or symbols',
  '4. any uncertainty or missing context'
].join('\n');

export const builtinSubagents: Record<'explore', BuiltinSubagentDefinition> = {
  explore: {
    allowedTools: ['batch', 'read', 'glob', 'grep'],
    description: 'Read-only code exploration specialist',
    name: 'explore',
    oneShot: true,
    systemPrompt: EXPLORE_SYSTEM_PROMPT
  }
};

export function getBuiltinSubagentDefinition(agentName: string) {
  if (agentName !== 'explore') {
    return null;
  }

  return builtinSubagents.explore;
}
