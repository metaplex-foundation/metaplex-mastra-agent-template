import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const sleep = createTool({
  id: 'sleep',
  description:
    'Pause execution for a specified number of seconds. Use this to implement polling loops — for example, checking a token price periodically. Maximum 300 seconds (5 minutes).',
  inputSchema: z.object({
    seconds: z
      .number()
      .min(1)
      .max(300)
      .describe('Number of seconds to sleep (1–300)'),
  }),
  outputSchema: z.object({
    sleptFor: z.number(),
    resumedAt: z.string(),
  }),
  execute: async ({ seconds }) => {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return {
      sleptFor: seconds,
      resumedAt: new Date().toISOString(),
    };
  },
});
