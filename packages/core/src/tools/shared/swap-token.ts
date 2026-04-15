import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  createUmi,
  executeSwap,
  type AgentContext,
} from '@metaplex-agent/shared';
import type { RequestContext } from '@mastra/core/request-context';

export const swapToken = createTool({
  id: 'swap-token',
  description:
    'Swap tokens via Jupiter DEX. Funds come from and go to the agent keypair wallet. Provide amounts in the smallest unit (lamports for SOL, base units for tokens).',
  inputSchema: z.object({
    inputMint: z.string().describe('Input token mint address'),
    outputMint: z.string().describe('Output token mint address'),
    amount: z.string().describe('Amount in smallest unit (e.g., lamports for SOL)'),
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
    inputAmount: z.string(),
    outputAmount: z.string(),
    priceImpact: z.string(),
    message: z.string(),
  }),
  execute: async ({ inputMint, outputMint, amount, slippageBps }, { requestContext }) => {
    const ctx = requestContext as RequestContext<AgentContext> | undefined;
    const agentAssetAddress = ctx?.get('agentAssetAddress');

    if (!agentAssetAddress) {
      return {
        signature: '',
        inputAmount: '',
        outputAmount: '',
        priceImpact: '',
        message: 'Agent must be registered first. No agent asset address found.',
      };
    }

    try {
      const umi = createUmi();

      const result = await executeSwap(umi, {
        walletAddress: umi.identity.publicKey.toString(),
        inputMint,
        outputMint,
        amount,
        slippageBps,
      });

      return {
        ...result,
        message: `Swap complete. Spent ${result.inputAmount} of ${inputMint}, received ${result.outputAmount} of ${outputMint}. Price impact: ${result.priceImpact}%.`,
      };
    } catch (error) {
      return {
        signature: '',
        inputAmount: '',
        outputAmount: '',
        priceImpact: '',
        message: `Swap failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});
