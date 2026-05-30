import { z } from 'zod';

export const sessionVariantSchema = z.enum(['plan', 'build']);

export type SessionVariant = z.infer<typeof sessionVariantSchema>;

export const sessionKindSchema = z.enum(['primary', 'subagent']);

export type SessionKind = z.infer<typeof sessionKindSchema>;

export const subagentTypeSchema = z.enum(['explore']);

export type SubagentType = z.infer<typeof subagentTypeSchema>;

export const sessionStatusSchema = z.enum([
  'planning',
  'idle',
  'executing',
  'waiting_approval',
  'blocked',
  'completed',
  'archived'
]);

export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const agentRunStatusSchema = z.enum([
  'running',
  'waiting_approval',
  'completed',
  'cancelled',
  'failed',
  'blocked'
]);

export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const createWorkspaceInputSchema = z.object({
  rootPath: z.string().trim().min(1)
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;

export const browseWorkspaceDirectoryQuerySchema = z.object({
  path: z.string().trim().min(1).optional()
});

export type BrowseWorkspaceDirectoryQuery = z.infer<
  typeof browseWorkspaceDirectoryQuerySchema
>;

export const createSessionInputSchema = z.object({
  defaultVariant: sessionVariantSchema.optional(),
  goalText: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
  workspaceId: z.string().trim().min(1)
});

export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;

export const submitSessionMessageInputSchema = z.object({
  content: z.string().trim().min(1),
  variant: sessionVariantSchema.optional()
});

export type SubmitSessionMessageInput = z.infer<
  typeof submitSessionMessageInputSchema
>;

export const cancelRunInputSchema = z.object({
  reason: z.string().trim().min(1).optional()
});

export type CancelRunInput = z.infer<typeof cancelRunInputSchema>;

export const manualCompactInputSchema = z.object({}).strict();

export type ManualCompactInput = z.infer<typeof manualCompactInputSchema>;
