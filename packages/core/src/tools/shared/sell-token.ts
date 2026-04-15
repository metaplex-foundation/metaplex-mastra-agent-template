import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  createUmi,
  executeSwap,
  SOL_MINT,
  type AgentContext,
} from '@metaplex-agent/shared';
import type { RequestContext } from '@mastra/core/request-context';

export const sellToken = createTool({
  id: 'sell-token',
  description:
    "Sell the agent's own token for SOL. Use this to fund operations or realize value. Be transparent about why you're selling.",
  inputSchema: z.object({
    tokenAmount: z
      .string()
      .describe('Amount of agent tokens to sell (in smallest unit / base units)'),
    slippageBps: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .describe('Slippage tolerance in basis points (default 50 = 0.5%)'),
  }),
  outputSchema: z.object({
    signature: z.string(),
    tokensSold: z.string(),
    solReceived: z.string(),
    priceImpact: z.string(),
    message: z.string(),
  }),
  execute: async ({ tokenAmount, slippageBps }, { requestContext }) => {
    const ctx = requestContext as RequestContext<AgentContext> | undefined;
    const agentAssetAddress = ctx?.get('agentAssetAddress');
    const agentTokenMint = ctx?.get('agentTokenMint');

    if (!agentAssetAddress) {
      return {
        signature: '',
        tokensSold: '',
        solReceived: '',
        priceImpact: '',
        message: 'Agent must be registered first. No agent asset address found.',
      };
    }

    if (!agentTokenMint) {
      return {
        signature: '',
        tokensSold: '',
        solReceived: '',
        priceImpact: '',
        message: 'No agent token found. Launch a token first using launch-token.',
      };
    }

    try {
      const umi = createUmi();

      const result = await executeSwap(umi, {
        walletAddress: umi.identity.publicKey.toString(),
        inputMint: agentTokenMint,
        outputMint: SOL_MINT,
        amount: tokenAmount,
        slippageBps,
      });

      return {
        signature: result.signature,
        tokensSold: result.inputAmount,
        solReceived: result.outputAmount,
        priceImpact: result.priceImpact,
        message: `Sell complete. Sold ${result.inputAmount} tokens, received ${result.outputAmount} lamports SOL. Price impact: ${result.priceImpact}%.`,
      };
    } catch (error) {
      return {
        signature: '',
        tokensSold: '',
        solReceived: '',
        priceImpact: '',
        message: `Sell failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});
