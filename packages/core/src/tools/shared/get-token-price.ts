import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BASE58_ADDRESS_RE, err, getConfig, info, ok, toToolError } from '@metaplex-agent/shared';

export const getTokenPrice = createTool({
  id: 'get-token-price',
  description:
    'Get the current USD price of a Solana token by its mint address. Uses the Jupiter Price API. Returns null price if the token is not listed or if JUPITER_API_KEY is not configured.',
  inputSchema: z.object({
    mintAddress: z
      .string()
      .regex(BASE58_ADDRESS_RE, 'mintAddress must be a valid base58 Solana address')
      .describe('The token mint address (base58-encoded). For SOL, use "So11111111111111111111111111111111111111112".'),
  }),
  outputSchema: z.object({
    status: z.string().optional(),
    code: z.string().optional(),
    mint: z.string().optional(),
    priceUsd: z.number().nullable().optional(),
    source: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async ({ mintAddress }) => {
    const config = getConfig();

    if (!config.JUPITER_API_KEY) {
      return info({
        mint: mintAddress,
        priceUsd: null,
        source: 'jupiter (no API key configured)',
        message: 'JUPITER_API_KEY not configured; returning null price.',
      });
    }

    try {
      const url = `https://api.jup.ag/price/v3?ids=${mintAddress}`;
      const response = await fetch(url, {
        headers: { 'x-api-key': config.JUPITER_API_KEY },
      });

      if (!response.ok) {
        return info({
          mint: mintAddress,
          priceUsd: null,
          source: 'jupiter',
          message: `Jupiter price API returned HTTP ${response.status}.`,
        });
      }

      const json = (await response.json()) as {
        data: Record<string, { id: string; type: string; price: string } | undefined>;
      };

      const tokenData = json.data?.[mintAddress];
      const priceUsd = tokenData?.price ? parseFloat(tokenData.price) : null;

      return ok({
        mint: mintAddress,
        priceUsd,
        source: 'jupiter',
      });
    } catch (error) {
      console.error('[get-token-price]', error);
      const { code, message } = toToolError(error);
      return err(code, `Failed to fetch token price for ${mintAddress}: ${message}`);
    }
  },
});
