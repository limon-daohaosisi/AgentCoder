export const TASK_STOP_TOOL_PROMPT = `Use this tool when a task that is currently running or waiting for approval must be intentionally stopped.

## What This Tool Does

- Marks the task as \`blocked\`
- Records the reason execution cannot continue
- Keeps the task on the board for later recovery or replanning

## When to Use This Tool

- Use it when an external dependency is missing.
- Use it when an assumption was invalidated and the task cannot safely continue.
- Use it when the user explicitly asks to stop work on the current task.
- Use it when continuing would be misleading or unsafe.

## When NOT to Use This Tool

- Do not use it to delete tasks.
- Do not use it as a substitute for marking a task \`done\`.
- Do not use it for tasks that never actually started; prefer task_update instead.

This tool is not a background process killer. It is a structured task-state transition for the session task board.`;
