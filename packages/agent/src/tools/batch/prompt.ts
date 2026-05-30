export const BATCH_TOOL_PROMPT = `Execute a related group of tool calls as one batch.

Use this tool when several tool calls are independent or naturally belong to one short workflow step.

Rules:
- Provide child tool calls in execution order using the tool_calls array.
- Each child must include a tool name and parameters object.
- Do not nest batch inside batch.
- Do not include plan_exit in a batch.
- Prefer read, glob, and grep together when gathering context in parallel.
- Only tools already enabled in the current runtime may be included. Disallowed child tools are ignored.
- Keep each batch focused. If steps depend on model reasoning between tool results, do not use batch.`;
