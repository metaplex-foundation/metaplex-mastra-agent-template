import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getConfig } from '@metaplex-agent/shared';

export const getTokenPrice = createTool({
  id: 'get-token-price',
  description:
    'Get the current USD price of a Solana token by its mint address. Uses the Jupiter Price API. Returns null price if the token is not listed or if JUPITER_API_KEY is not configured.',
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
    const config = getConfig();

    if (!config.JUPITER_API_KEY) {
      return {
        mint: mintAddress,
        priceUsd: null,
        source: 'jupiter (no API key configured)',
      };
    }

    const url = `https://api.jup.ag/price/v3?ids=${mintAddress}`;
    const response = await fetch(url, {
      headers: { 'x-api-key': config.JUPITER_API_KEY },
    });

    if (!response.ok) {
      return {
        mint: mintAddress,
        priceUsd: null,
        source: 'jupiter',
      };
    }

    const data = (await response.json()) as
      Record<string, { usdPrice: number } | undefined>;

    const tokenData = data[mintAddress];
    const priceUsd = tokenData ? tokenData.usdPrice : null;

    return {
      mint: mintAddress,
      priceUsd,
      source: 'jupiter',
    };
  },
});
