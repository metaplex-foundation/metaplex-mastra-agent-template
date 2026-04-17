import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { err, ok } from '@metaplex-agent/shared';

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
    status: z.string().optional(),
    code: z.string().optional(),
    sleptFor: z.number().optional(),
    resumedAt: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async ({ seconds }, { requestContext }) => {
    // The server sets 'abortSignal' on the RequestContext before calling
    // agent.stream(). Read it here so the sleep is interruptible by client
    // disconnect, cumulative-time-budget abort, or any other cancel signal (H5).
    const ctx: any = requestContext;
    const signal: AbortSignal | null = ctx?.get?.('abortSignal') ?? null;

    if (signal?.aborted) {
      return err('TIMEOUT', 'Sleep aborted before it started.');
    }

    try {
      await new Promise<void>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const onAbort = () => {
          if (timeout) clearTimeout(timeout);
          reject(new Error('Sleep aborted'));
        };
        timeout = setTimeout(() => {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve();
        }, seconds * 1000);
        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err('TIMEOUT', `Sleep interrupted: ${message}`);
    }

    return ok({
      sleptFor: seconds,
      resumedAt: new Date().toISOString(),
    });
  },
});
