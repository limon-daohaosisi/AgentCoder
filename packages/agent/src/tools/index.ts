import type { AnyToolDefinition, ToolDefinition, ToolName } from './types.js';
import { applyPatchToolDefinition } from './apply_patch/index.js';
import { bashToolDefinition } from './bash/index.js';
import { editToolDefinition } from './edit/index.js';
import { globToolDefinition } from './glob/index.js';
import { grepToolDefinition } from './grep/index.js';
import { planExitToolDefinition } from './plan_exit/index.js';
import { readToolDefinition } from './read/index.js';
import { taskCreateToolDefinition } from './task_create/index.js';
import { taskGetToolDefinition } from './task_get/index.js';
import { taskListToolDefinition } from './task_list/index.js';
import { taskStopToolDefinition } from './task_stop/index.js';
import { taskUpdateToolDefinition } from './task_update/index.js';
import { writeToolDefinition } from './write/index.js';

export { applyPatchToolDefinition } from './apply_patch/index.js';
export { applyPatchInputSchema } from './apply_patch/index.js';
export { bashToolDefinition } from './bash/index.js';
export { bashInputSchema } from './bash/index.js';
export { editToolDefinition } from './edit/index.js';
export { editInputSchema } from './edit/index.js';
export { globToolDefinition } from './glob/index.js';
export { globInputSchema } from './glob/index.js';
export { grepToolDefinition } from './grep/index.js';
export { grepInputSchema } from './grep/index.js';
export { planExitToolDefinition } from './plan_exit/index.js';
export { planExitInputSchema } from './plan_exit/index.js';
export { readToolDefinition } from './read/index.js';
export { readInputSchema } from './read/index.js';
export { taskCreateToolDefinition } from './task_create/index.js';
export { taskCreateInputSchema } from './task_create/index.js';
export { taskGetToolDefinition } from './task_get/index.js';
export { taskGetInputSchema } from './task_get/index.js';
export { taskListToolDefinition } from './task_list/index.js';
export { taskListInputSchema } from './task_list/index.js';
export { taskStopToolDefinition } from './task_stop/index.js';
export { taskStopInputSchema } from './task_stop/index.js';
export { taskUpdateToolDefinition } from './task_update/index.js';
export { taskUpdateInputSchema } from './task_update/index.js';
export { writeToolDefinition } from './write/index.js';
export { writeInputSchema } from './write/index.js';
export { assertNonInteractiveCommand } from './guards.js';
export { createUnifiedDiff } from './diff.js';
export {
  buildToolExecutionContext,
  DEFAULT_TOOL_OUTPUT_POLICY
} from './core.js';
export type {
  FileSnapshotArtifact,
  FileSnapshotStore,
  FileSnapshotStoreLookup
} from './shared/file-snapshot.js';
export type {
  AnyToolDefinition,
  ApprovalToolName,
  ToolAttachmentPolicy,
  ToolDefinition,
  ToolErrorPolicy,
  ToolErrorVisibility,
  ToolExecutionContext,
  ToolJsonFieldSpec,
  ToolName,
  ToolOutputPolicy,
  ToolOutputVisibility,
  ToolPresentation,
  ToolTextPolicy,
  ToolServices
} from './types.js';

export const toolRegistry: AnyToolDefinition[] = [
  readToolDefinition,
  globToolDefinition,
  grepToolDefinition,
  taskCreateToolDefinition,
  taskListToolDefinition,
  taskGetToolDefinition,
  taskUpdateToolDefinition,
  taskStopToolDefinition,
  planExitToolDefinition,
  applyPatchToolDefinition,
  bashToolDefinition,
  writeToolDefinition,
  editToolDefinition
];

export const toolByName = Object.fromEntries(
  toolRegistry.map((definition) => [definition.name, definition])
) as Record<ToolName, AnyToolDefinition>;
