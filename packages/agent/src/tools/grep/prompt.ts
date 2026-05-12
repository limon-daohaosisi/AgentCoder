export const GREP_TOOL_PROMPT = `Search file contents with a regular expression inside the workspace.

Usage:
- Use grep when you know what text or pattern you need to search for.
- Use grep instead of invoking grep or rg through bash when the dedicated grep tool can do the job.
- Use glob instead when you are trying to locate files by filename or path pattern.
- Use the include filter to narrow which filenames should be searched.
- Use the path parameter to narrow the search area when helpful.
- Results are returned as matching files with line numbers so you can read the relevant locations precisely.
- Prefer grep over shell grep or ad hoc shell search commands.`;
