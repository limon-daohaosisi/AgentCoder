export const BASH_TOOL_PROMPT = `Run a non-interactive shell command inside the workspace.

Use this tool for development commands such as tests, builds, git inspection, package manager commands, and other shell operations that are directly relevant to the user's task.

Important rules:
- Always provide a short description of what the command does.
- Use the workdir parameter instead of changing directories inside the command when possible.
- Prefer dedicated tools over shell commands for file reading, file writing, file editing, and content search.
- Do not use interactive commands.
- Expect non-zero exit codes to be returned as command results rather than tool failures.
- If a command will create files or directories, first verify the parent location exists and is the intended place.
- Quote paths that contain spaces.
- If several commands are independent, prefer multiple tool calls in parallel.
- If commands depend on each other, keep them together in one shell invocation only when necessary.

Git safety:
- Do not create commits unless the user explicitly asks you to.
- Do not push unless the user explicitly asks you to.
- Do not use destructive git commands such as reset --hard or force-push unless the user explicitly requests them.
- Do not skip hooks unless the user explicitly asks you to do so.
- Prefer inspecting repository state before taking write-like git actions.

Do not use bash for unrelated exploration when dedicated tools would be more precise.`;
