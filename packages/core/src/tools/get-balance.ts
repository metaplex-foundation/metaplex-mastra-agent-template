import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-agent/shared';

export const getBalance = createTool({
  id: 'get-balance',
  description:
    'Get the SOL balance of a Solana wallet address. Returns the balance in SOL.',
  inputSchema: z.object({
    address: z
      .string()
      .describe('The Solana wallet address (base58-encoded public key)'),
  }),
  outputSchema: z.object({
    address: z.string(),
    balanceSol: z.number(),
    balanceLamports: z.string(),
  }),
  execute: async ({ address }) => {
    const umi = createUmi();
    const pubkey = publicKey(address);
    const balance = await umi.rpc.getBalance(pubkey);
    const lamports = balance.basisPoints.toString();
    const sol = Number(balance.basisPoints) / 1_000_000_000;

    return {
      address,
      balanceSol: sol,
      balanceLamports: lamports,
    };
  },
});
