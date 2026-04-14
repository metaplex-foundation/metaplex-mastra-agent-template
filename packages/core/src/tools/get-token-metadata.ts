import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createUmi } from '@metaplex-agent/shared';

export const getTokenMetadata = createTool({
  id: 'get-token-metadata',
  description:
    'Get metadata (name, symbol, image) for a Solana token by its mint address. Uses the DAS API. Returns null fields if metadata is unavailable.',
  inputSchema: z.object({
    mintAddress: z
      .string()
      .describe('The token mint address (base58-encoded)'),
  }),
  outputSchema: z.object({
    mint: z.string(),
    name: z.string().nullable(),
    symbol: z.string().nullable(),
    image: z.string().nullable(),
  }),
  execute: async ({ mintAddress }) => {
    const umi = createUmi();

    try {
      const asset = await umi.rpc.call<{
        content: {
          metadata: { name?: string; symbol?: string };
          links?: { image?: string };
        };
      }>('getAsset', [mintAddress]);

      return {
        mint: mintAddress,
        name: asset.content.metadata.name ?? null,
        symbol: asset.content.metadata.symbol ?? null,
        image: asset.content.links?.image ?? null,
      };
    } catch {
      return {
        mint: mintAddress,
        name: null,
        symbol: null,
        image: null,
      };
    }
  },
});
