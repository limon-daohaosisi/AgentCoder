import { createSessionInputSchema } from '@opencode/shared';
import { z } from 'zod';

const idSchema = z.string().trim().min(1);

export const SessionsSchemas = {
  list: {
    query: z.object({
      workspaceId: idSchema
    })
  },

  create: {
    json: createSessionInputSchema
  },

  byId: {
    param: z.object({
      sessionId: idSchema
    })
  },

  restoreRevert: {
    json: z.object({}),
    param: z.object({
      sessionId: idSchema
    })
  },

  revert: {
    json: z.object({
      messageId: idSchema
    }),
    param: z.object({
      sessionId: idSchema
    })
  }
};
