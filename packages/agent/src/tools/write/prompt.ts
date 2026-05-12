export const WRITE_TOOL_PROMPT = `Write the full contents of a file inside the workspace.

Usage:
- Use this for creating a new file or replacing the entire contents of an existing file.
- Existing files must be read first so you understand the current contents before overwriting them. The tool should fail if an existing file was not fully read first.
- If you only need to change part of an existing file, prefer apply_patch or edit.
- Do not use write for small targeted edits when a patch would be safer and clearer.
- Be careful: writing replaces the file contents rather than editing them incrementally.
- Do not create README or documentation files unless they were explicitly requested or are clearly required for the user's task.
- Do not create extra helper files unless they are actually needed for the user's request.`;
