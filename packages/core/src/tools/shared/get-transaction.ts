import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createUmi } from '@metaplex-agent/shared';

export const getTransaction = createTool({
  id: 'get-transaction',
  description:
    'Look up a Solana transaction by its signature. Returns transaction status and error information if any.',
  inputSchema: z.object({
    signature: z
      .string()
      .describe('The transaction signature (base58-encoded)'),
  }),
  outputSchema: z.object({
    signature: z.string(),
    found: z.boolean(),
    slot: z.number().optional(),
    err: z.any().optional(),
  }),
  execute: async ({ signature }) => {
    const umi = createUmi();

    // Use RPC call to getSignatureStatuses
    const result = await umi.rpc.call<{
      value: Array<{ slot: number; confirmationStatus: string; err: unknown } | null>;
    }>('getSignatureStatuses', [[signature]], {
      extra: { searchTransactionHistory: true },
    });

    const status = result.value[0];

    if (!status) {
      return {
        signature,
        found: false,
      };
    }

    return {
      signature,
      found: true,
      slot: status.slot,
      err: status.err,
    };
  },
});
