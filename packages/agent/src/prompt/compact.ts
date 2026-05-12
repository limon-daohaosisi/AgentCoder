export function buildCompactionSystemOverlay() {
  return [
    'You are compacting the durable transcript so the agent can continue the task.',
    '',
    'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.',
    'Do not call tools.',
    '',
    'Your entire response must be plain text: an <analysis> block followed by a <summary> block.',
    '',
    '- Do NOT use read, glob, grep, edit, write, apply_patch, bash, or any other tool.',
    '- Tool calls will be rejected and will waste your only turn.',
    '- If you need scratch space, keep it brief inside <analysis>.',
    '- Put the final answer in <summary>.',
    "- Do not answer the user's original task.",
    '- Do not continue implementation.',
    '- Only produce a durable continuation summary.',
    '',
    'Preserve only durable, execution-relevant facts that are needed for continuing the work.',
    '',
    'Use these sections in order inside <summary>:',
    '1. Current Objective',
    '2. Important Constraints',
    '3. Relevant Files / Areas',
    '4. Decisions Already Made',
    '5. Outstanding Work',
    '6. Tool Findings Worth Preserving',
    '7. Open Risks / Unknowns'
  ].join('\n');
}

export function buildCompactionPrompt(input: {
  preCompactTokenCount: number;
  transcript: string;
}) {
  return [
    'Compact the following transcript into a durable continuation summary.',
    '',
    `Pre-compact estimated tokens: ${input.preCompactTokenCount}.`,
    '',
    'Summarize what matters for continuing the task without losing execution context.',
    '',
    'Focus on:',
    "- the user's current goal",
    '- hard constraints and preferences',
    '- files, directories, and code areas that matter',
    '- decisions already made and why they matter',
    '- work completed versus work still outstanding',
    '- concrete tool findings worth preserving',
    '- unresolved risks, blockers, or unknowns',
    '',
    'Do not include speculative filler.',
    'Do not include hidden chain-of-thought beyond a short disposable <analysis> block.',
    'Do not quote large tool outputs unless specific lines are important for continuing the work.',
    '',
    'Your response must be plain text in exactly this structure:',
    '',
    '<analysis>',
    '[brief working notes]',
    '</analysis>',
    '',
    '<summary>',
    '## Current Objective',
    '...',
    '',
    '## Important Constraints',
    '...',
    '',
    '## Relevant Files / Areas',
    '...',
    '',
    '## Decisions Already Made',
    '...',
    '',
    '## Outstanding Work',
    '...',
    '',
    '## Tool Findings Worth Preserving',
    '...',
    '',
    '## Open Risks / Unknowns',
    '...',
    '</summary>',
    '',
    '<transcript>',
    input.transcript,
    '</transcript>'
  ].join('\n');
}

export function buildPostCompactContextText(input: {
  recoveredReads: Array<{ filePath: string; outputText: string }>;
  sessionStartBlocks: string[];
}) {
  const sections: string[] = [];

  if (input.recoveredReads.length > 0) {
    sections.push('Post-compact working set:');

    for (const recovery of input.recoveredReads) {
      sections.push(`Recovered recent read for ${recovery.filePath}:`);
      sections.push(recovery.outputText);
    }
  }

  if (input.sessionStartBlocks.length > 0) {
    sections.push('Session start context:');
    sections.push(...input.sessionStartBlocks);
  }

  return sections.join('\n\n').trim();
}
