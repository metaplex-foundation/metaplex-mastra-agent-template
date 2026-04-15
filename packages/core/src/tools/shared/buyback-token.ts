import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  createUmi,
  executeSwap,
  SOL_MINT,
  type AgentContext,
} from '@metaplex-agent/shared';
import type { RequestContext } from '@mastra/core/request-context';

export const buybackToken = createTool({
  id: 'buyback-token',
  description:
    "Buy back the agent's own token using SOL from the agent keypair wallet. Use this to support your token price or accumulate more of your own token.",
  inputSchema: z.object({
    solAmount: z
      .number()
      .positive()
      .describe('Amount of SOL to spend on buying back the agent token'),
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
    solSpent: z.string(),
    tokensReceived: z.string(),
    priceImpact: z.string(),
    message: z.string(),
  }),
  execute: async ({ solAmount, slippageBps }, { requestContext }) => {
    const ctx = requestContext as RequestContext<AgentContext> | undefined;
    const agentAssetAddress = ctx?.get('agentAssetAddress');
    const agentTokenMint = ctx?.get('agentTokenMint');

    if (!agentAssetAddress) {
      return {
        signature: '',
        solSpent: '',
        tokensReceived: '',
        priceImpact: '',
        message: 'Agent must be registered first. No agent asset address found.',
      };
    }

    if (!agentTokenMint) {
      return {
        signature: '',
        solSpent: '',
        tokensReceived: '',
        priceImpact: '',
        message: 'No agent token found. Launch a token first using launch-token.',
      };
    }

    try {
      const umi = createUmi();
      const lamports = String(Math.floor(solAmount * 1_000_000_000));

      const result = await executeSwap(umi, {
        walletAddress: umi.identity.publicKey.toString(),
        inputMint: SOL_MINT,
        outputMint: agentTokenMint,
        amount: lamports,
        slippageBps,
      });

      return {
        signature: result.signature,
        solSpent: result.inputAmount,
        tokensReceived: result.outputAmount,
        priceImpact: result.priceImpact,
        message: `Buyback complete. Spent ${solAmount} SOL, received ${result.outputAmount} tokens. Price impact: ${result.priceImpact}%.`,
      };
    } catch (error) {
      return {
        signature: '',
        solSpent: '',
        tokensReceived: '',
        priceImpact: '',
        message: `Buyback failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});
