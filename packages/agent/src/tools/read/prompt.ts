export const READ_TOOL_PROMPT = `Read a file or directory from the local workspace.

Usage:
- The filePath parameter must point to a path inside the workspace.
- By default, this tool returns up to 2000 lines from the start of the file or directory.
- The offset parameter is 1-indexed.
- Use offset and limit when you already know which part you need, especially for large files.
- If you need more context, prefer reading a larger chunk instead of many tiny repeated slices.
- Read the full file before making changes with edit, write, or apply_patch when the existing file contents matter.
- If you are unsure of the exact path, use glob first to locate candidate paths.
- If you need to search file contents by pattern, use grep instead of repeatedly reading unrelated files.
- File contents are returned with line numbers so you can reference exact lines.
- Directory reads return entries in that directory rather than file contents.
- If the path does not exist, treat that as a signal to locate the correct path rather than assuming the task is blocked.`;
