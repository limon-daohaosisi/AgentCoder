import {
  browseWorkspaceDirectoryQuerySchema,
  createWorkspaceInputSchema
} from '@opencode/shared';
import { z } from 'zod';

export const WorkspacesSchemas = {
  browse: {
    query: browseWorkspaceDirectoryQuerySchema
  },

  create: {
    json: createWorkspaceInputSchema
  },

  tree: {
    param: z.object({
      workspaceId: z.string().trim().min(1)
    })
  }
};
