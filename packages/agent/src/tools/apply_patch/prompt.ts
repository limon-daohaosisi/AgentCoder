export const APPLY_PATCH_TOOL_PROMPT = `Apply a structured patch to one or more files inside the workspace.

Use this for targeted edits to existing files, especially larger files where rewriting the full file would be unnecessary.

Patch format rules:
- The patch must start with *** Begin Patch and end with *** End Patch.
- Each file operation must use one of these headers:
  *** Add File: <path>
  *** Update File: <path>
  *** Delete File: <path>
- Added files must use + prefixes for every content line.
- Updated files should use focused hunks so the intended change is clear.

Usage guidance:
- Read the file first when updating an existing file.
- Prefer apply_patch over write for partial changes.
- Prefer write over apply_patch when creating a brand new file whose full contents are already known.
- Keep patches as small as possible while still being correct.`;
