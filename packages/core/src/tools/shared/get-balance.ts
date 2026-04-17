import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey } from '@metaplex-foundation/umi';
import { BASE58_ADDRESS_RE, createUmi, err, ok, toToolError } from '@metaplex-agent/shared';

export const getBalance = createTool({
  id: 'get-balance',
  description:
    'Get the SOL balance of a Solana wallet address. Returns the balance in SOL.',
  inputSchema: z.object({
    address: z
      .string()
      .regex(BASE58_ADDRESS_RE, 'address must be a valid base58 Solana address')
      .describe('The Solana wallet address (base58-encoded public key)'),
  }),
  outputSchema: z.object({
    status: z.string().optional(),
    code: z.string().optional(),
    address: z.string().optional(),
    balanceSol: z.number().optional(),
    balanceLamports: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async ({ address }) => {
    try {
      const umi = createUmi();
      const pubkey = publicKey(address);
      const balance = await umi.rpc.getBalance(pubkey);
      const lamports = balance.basisPoints.toString();
      const sol = Number(balance.basisPoints) / 1_000_000_000;

      return ok({
        address,
        balanceSol: sol,
        balanceLamports: lamports,
      });
    } catch (error) {
      console.error('[get-balance]', error);
      const { code, message } = toToolError(error);
      return err(code, `Failed to get balance for ${address}: ${message}`);
    }
  },
});
