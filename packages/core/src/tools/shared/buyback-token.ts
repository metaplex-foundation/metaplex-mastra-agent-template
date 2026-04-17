import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  createUmi,
  err,
  executeSwap,
  getConfig,
  ok,
  SOL_MINT,
  toToolError,
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
      .finite()
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
    status: z.string().optional(),
    code: z.string().optional(),
    signature: z.string().optional(),
    solSpent: z.string().optional(),
    tokensReceived: z.string().optional(),
    priceImpact: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async ({ solAmount, slippageBps }, { requestContext }) => {
    const ctx = requestContext as RequestContext<AgentContext> | undefined;
    const agentAssetAddress = ctx?.get('agentAssetAddress');
    const tokenOverride = ctx?.get('tokenOverride');
    const agentTokenMint = tokenOverride ?? ctx?.get('agentTokenMint');

    if (!agentAssetAddress) {
      return err('NOT_REGISTERED', 'Agent must be registered first. No agent asset address found.');
    }

    if (!agentTokenMint) {
      return err(
        'NO_TOKEN',
        'No token configured. Launch a token with launch-token, or set TOKEN_OVERRIDE in .env.',
      );
    }

    const config = getConfig();
    if (slippageBps !== undefined && slippageBps > config.MAX_SLIPPAGE_BPS) {
      return err(
        'SLIPPAGE_TOO_HIGH',
        `Slippage ${slippageBps} bps exceeds configured max of ${config.MAX_SLIPPAGE_BPS} bps`,
      );
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

      return ok({
        signature: result.signature,
        solSpent: result.inputAmount,
        tokensReceived: result.outputAmount,
        priceImpact: result.priceImpact,
        message: `Buyback complete. Spent ${solAmount} SOL, received ${result.outputAmount} tokens. Price impact: ${result.priceImpact}%.`,
      });
    } catch (error) {
      console.error('[buyback-token]', error);
      if (error instanceof Error && error.message.startsWith('INTEGRITY:')) {
        return err('INTEGRITY', `Buyback refused: ${error.message.slice('INTEGRITY:'.length).trim()}`);
      }
      const { code, message } = toToolError(error);
      return err(code, `Buyback failed: ${message}`);
    }
  },
});
