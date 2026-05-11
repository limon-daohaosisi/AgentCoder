import {
  cancelRunInputSchema,
  manualCompactInputSchema,
  submitSessionMessageInputSchema
} from '@opencode/shared';
import { z } from 'zod';

export const AgentSchemas = {
  cancelCurrentRun: {
    json: cancelRunInputSchema,
    param: z.object({
      sessionId: z.string().trim().min(1)
    })
  },

  manualCompact: {
    json: manualCompactInputSchema,
    param: z.object({
      sessionId: z.string().trim().min(1)
    })
  },

  submitMessage: {
    json: submitSessionMessageInputSchema,
    param: z.object({
      sessionId: z.string().trim().min(1)
    })
  },

  stream: {
    param: z.object({
      sessionId: z.string().trim().min(1)
    })
  }
};
