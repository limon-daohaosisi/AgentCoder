export const TASK_LIST_TOOL_PROMPT = `Use this tool to list all tasks in the current session plan.

## When to Use This Tool

- Use it before creating new tasks, so you understand the current board and avoid duplicates.
- Use it to check overall progress and identify the current task.
- Use it after completing, blocking, or pausing a task to decide what remains.
- In build mode, prefer checking the task list before starting the next task.

## Output

Returns a summary of each task, including:
- id
- title
- status
- summaryText
- lastErrorText

Use task_get with a specific task ID when you need the full description and acceptance criteria.`;
