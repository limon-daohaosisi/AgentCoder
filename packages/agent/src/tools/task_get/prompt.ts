export const TASK_GET_TOOL_PROMPT = `Use this tool to retrieve a task by its ID from the current session plan.

## When to Use This Tool

- Use it when you need the full description and acceptance criteria before starting work.
- Use it before task_update or task_stop if you may be acting on stale information.
- Use it when you need to understand the latest state of the current task in detail.

## Output

Returns full task details, including:
- title
- description
- acceptanceCriteria
- status
- summaryText
- lastErrorText

Use task_list to see the full board in summary form.`;
