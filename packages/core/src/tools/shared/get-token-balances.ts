import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey } from '@metaplex-foundation/umi';
import {
  fetchAllTokenByOwner,
  fetchMint,
} from '@metaplex-foundation/mpl-toolbox';
import { createUmi } from '@metaplex-agent/shared';

export const getTokenBalances = createTool({
  id: 'get-token-balances',
  description:
    'Get all SPL token holdings for a Solana wallet. Returns mint addresses, raw amounts, and human-readable amounts with decimals.',
  inputSchema: z.object({
    address: z
      .string()
      .describe('The Solana wallet address (base58-encoded public key)'),
  }),
  outputSchema: z.object({
    address: z.string(),
    tokens: z.array(
      z.object({
        mint: z.string(),
        rawAmount: z.string(),
        decimals: z.number(),
        uiAmount: z.number(),
      })
    ),
  }),
  execute: async ({ address }) => {
    const umi = createUmi();
    const owner = publicKey(address);
    const tokenAccounts = await fetchAllTokenByOwner(umi, owner);

    const tokens = await Promise.all(
      tokenAccounts
        .filter((ta) => ta.amount > 0n)
        .map(async (ta) => {
          const mintAccount = await fetchMint(umi, ta.mint);
          const uiAmount =
            Number(ta.amount) / Math.pow(10, mintAccount.decimals);
          return {
            mint: ta.mint.toString(),
            rawAmount: ta.amount.toString(),
            decimals: mintAccount.decimals,
            uiAmount,
          };
        })
    );

    return { address, tokens };
  },
});
