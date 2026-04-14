import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const getTokenPrice = createTool({
  id: 'get-token-price',
  description:
    'Get the current USD price of a Solana token by its mint address. Uses the Jupiter Price API. Returns null price if the token is not listed.',
  inputSchema: z.object({
    mintAddress: z
      .string()
      .describe('The token mint address (base58-encoded). For SOL, use "So11111111111111111111111111111111111111112".'),
  }),
  outputSchema: z.object({
    mint: z.string(),
    priceUsd: z.number().nullable(),
    source: z.string(),
  }),
  execute: async ({ mintAddress }) => {
    const url = `https://api.jup.ag/price/v2?ids=${mintAddress}`;
    const response = await fetch(url);

    if (!response.ok) {
      return {
        mint: mintAddress,
        priceUsd: null,
        source: 'jupiter',
      };
    }

    const data = (await response.json()) as {
      data: Record<string, { price: string } | undefined>;
    };

    const tokenData = data.data[mintAddress];
    const priceUsd = tokenData ? parseFloat(tokenData.price) : null;

    return {
      mint: mintAddress,
      priceUsd,
      source: 'jupiter',
    };
  },
});
