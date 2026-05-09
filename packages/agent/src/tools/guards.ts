const INTERACTIVE_COMMANDS = new Set([
  'less',
  'more',
  'nano',
  'nvim',
  'top',
  'vim',
  'watch'
]);

function splitCommandSegments(command: string) {
  return command
    .split(/(?:&&|\|\||;|\|)/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function assertNonInteractiveCommand(command: string) {
  for (const segment of splitCommandSegments(command)) {
    const baseCommand = segment.split(/\s+/u)[0]?.toLowerCase();

    if (!baseCommand) {
      continue;
    }

    if (INTERACTIVE_COMMANDS.has(baseCommand)) {
      throw new Error(
        `Command ${baseCommand} is not supported in the non-interactive bash tool.`
      );
    }
  }
}
