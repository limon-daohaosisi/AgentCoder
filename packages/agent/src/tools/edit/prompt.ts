export const EDIT_TOOL_PROMPT = `Edit an existing file by replacing exact text.

Usage:
- Read the file first.
- Use this tool only when exact text replacement is the right operation.
- Use the smallest oldString that is still clearly unique.
- Keep the target text specific enough to match the intended location and avoid accidental replacements.
- Use replaceAll only when every occurrence should change.
- Do not include read-tool line number prefixes in the text you are replacing.
- If oldString is not unique, the edit should fail unless replaceAll is the intended operation.
- If the change is broader, multi-location, or easier to express as a patch, prefer apply_patch.`;
