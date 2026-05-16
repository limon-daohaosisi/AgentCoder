export const TASK_UPDATE_TOOL_PROMPT = `Use this tool to update a task in the current session plan.

## When to Use This Tool

- Use it to refine task content during plan mode.
- Use it to move a task through its execution states during build.
- Use it to record execution summaries, blockers, and errors.

## Rules

- In plan mode, you may update any task fields, including structure fields and execution-tracking fields, when that helps keep the plan and task board accurate.
- In build mode, you may only update execution fields: status, summaryText, lastErrorText, startedAt, completedAt.
- Never use task_update in build mode to change task structure or to indirectly grow or shrink the task set.
- Only mark a task \`done\` when the work is fully accomplished and validated.
- If a task is paused on approval or blocked by missing prerequisites, update that state clearly instead of pretending it is complete.

## Staleness

- Read the latest task state with task_get before updating if the task may have changed since you last inspected it.`;
