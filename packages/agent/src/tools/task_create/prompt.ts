export const TASK_CREATE_TOOL_PROMPT = `Use this tool to create a structured task in the current session's task board.

## When to Use This Tool

- Use it proactively during plan mode when the work should be broken into multiple meaningful steps.
- Use it when the user request is complex enough that tracking progress on the board will help execution.
- Use it when a missing task needs to be added before implementation begins.

## When NOT to Use This Tool

- Do not use it for a single trivial task.
- Do not use it after the session has entered build. Task creation is frozen once implementation begins.

## Tips

- Check task_list first to avoid duplicate tasks.
- Create tasks with clear titles, concise descriptions, and concrete acceptance criteria.
- Default new tasks to \`todo\`. Use \`ready\` only when the task is immediately executable.
- Create stable tasks that can survive the full session, not throwaway scratch notes.`;
