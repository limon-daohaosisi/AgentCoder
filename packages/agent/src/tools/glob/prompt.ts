export const GLOB_TOOL_PROMPT = `Find workspace files or directories by glob pattern.

Usage:
- Use glob when you know the filename or path pattern you want to match.
- This is the preferred tool when the user names a file but does not provide a reliable path.
- Use glob before read when the exact location is uncertain.
- Use glob after a read failure caused by a missing path if there is a clear filename pattern to search for.
- Prefer grep instead when you need to search inside file contents rather than by filename.
- Results are returned sorted by modification time.
- Results are best used as candidate paths for follow-up reads or edits.`;
