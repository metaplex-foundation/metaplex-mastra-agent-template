import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BASE58_SIGNATURE_RE, createUmi, err, info, ok, toToolError } from '@metaplex-agent/shared';

export const getTransaction = createTool({
  id: 'get-transaction',
  description:
    'Look up a Solana transaction by its signature. Returns transaction status and error information if any.',
  inputSchema: z.object({
    signature: z
      .string()
      .regex(BASE58_SIGNATURE_RE, 'signature must be a valid base58-encoded Solana transaction signature')
      .describe('The transaction signature (base58-encoded)'),
  }),
  outputSchema: z.object({
    status: z.string().optional(),
    code: z.string().optional(),
    signature: z.string().optional(),
    found: z.boolean().optional(),
    slot: z.number().optional(),
    err: z.any().optional(),
    message: z.string().optional(),
  }),
  execute: async ({ signature }) => {
    try {
      const umi = createUmi();

      // Use RPC call to getSignatureStatuses
      const result = await umi.rpc.call<{
        value: Array<{ slot: number; confirmationStatus: string; err: unknown } | null>;
      }>('getSignatureStatuses', [[signature]], {
        extra: { searchTransactionHistory: true },
      });

      const txStatus = result.value[0];

      if (!txStatus) {
        return info({
          signature,
          found: false,
          message: `Transaction ${signature} not found.`,
        });
      }

      return ok({
        signature,
        found: true,
        slot: txStatus.slot,
        err: txStatus.err,
      });
    } catch (error) {
      console.error('[get-transaction]', error);
      const { code, message } = toToolError(error);
      return err(code, `Failed to get transaction ${signature}: ${message}`);
    }
  },
});
