import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  BASE58_ADDRESS_RE,
  createUmi,
  err,
  executeSwap,
  getConfig,
  ok,
  toToolError,
  type AgentContext,
} from '@metaplex-agent/shared';
import type { RequestContext } from '@mastra/core/request-context';

export const swapToken = createTool({
  id: 'swap-token',
  description:
    'Swap tokens via Jupiter DEX. Funds come from and go to the agent keypair wallet. Provide amounts in the smallest unit (lamports for SOL, base units for tokens).',
  inputSchema: z.object({
    inputMint: z
      .string()
      .regex(BASE58_ADDRESS_RE, 'inputMint must be a valid base58 Solana address')
      .describe('Input token mint address'),
    outputMint: z
      .string()
      .regex(BASE58_ADDRESS_RE, 'outputMint must be a valid base58 Solana address')
      .describe('Output token mint address'),
    amount: z
      .string()
      .regex(/^\d+(\.\d+)?$/, 'amount must be a positive decimal number string')
      .refine((s) => Number(s) > 0, 'amount must be positive')
      .describe('Amount in smallest unit (e.g., lamports for SOL)'),
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
    inputAmount: z.string().optional(),
    outputAmount: z.string().optional(),
    priceImpact: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async ({ inputMint, outputMint, amount, slippageBps }, { requestContext }) => {
    const ctx = requestContext as RequestContext<AgentContext> | undefined;
    const agentAssetAddress = ctx?.get('agentAssetAddress');

    if (!agentAssetAddress) {
      return err('NOT_REGISTERED', 'Agent must be registered first. No agent asset address found.');
    }

    // Runtime slippage cap: schema stays permissive so operators can tune
    // via env without a code change; the hard ceiling lives here.
    const config = getConfig();
    if (slippageBps !== undefined && slippageBps > config.MAX_SLIPPAGE_BPS) {
      return err(
        'SLIPPAGE_TOO_HIGH',
        `Slippage ${slippageBps} bps exceeds configured max of ${config.MAX_SLIPPAGE_BPS} bps`,
      );
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

      return ok({
        signature: result.signature,
        inputAmount: result.inputAmount,
        outputAmount: result.outputAmount,
        priceImpact: result.priceImpact,
        message: `Swap complete. Spent ${result.inputAmount} of ${inputMint}, received ${result.outputAmount} of ${outputMint}. Price impact: ${result.priceImpact}%.`,
      });
    } catch (error) {
      console.error('[swap-token]', error);
      // INTEGRITY errors from simulateAndVerifySwap (C6) surface as
      // plain Error objects whose message starts with 'INTEGRITY:'.
      if (error instanceof Error && error.message.startsWith('INTEGRITY:')) {
        return err('INTEGRITY', `Swap refused: ${error.message.slice('INTEGRITY:'.length).trim()}`);
      }
      const { code, message } = toToolError(error);
      return err(code, `Swap failed: ${message}`);
    }
  },
});
