import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  publicKey,
  sol,
  createNoopSigner,
} from '@metaplex-foundation/umi';
import { transferSol as transferSolIx } from '@metaplex-foundation/mpl-toolbox';
import {
  createUmi,
  submitOrSend,
  type AgentContext,
} from '@metaplex-agent/shared';
import type { RequestContext } from '@mastra/core/request-context';

export const transferSol = createTool({
  id: 'transfer-sol',
  description:
    'Transfer SOL from the connected wallet (public mode) or agent wallet (autonomous mode) to a destination address.',
  inputSchema: z.object({
    destination: z
      .string()
      .describe('The recipient Solana wallet address'),
    amount: z
      .number()
      .positive()
      .describe('Amount of SOL to transfer'),
  }),
  outputSchema: z.object({
    status: z.string(),
    signature: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ destination, amount }, { requestContext }) => {
    const ctx = requestContext as RequestContext<AgentContext> | undefined;
    const context: AgentContext = {
      walletAddress: ctx?.get('walletAddress') ?? null,
      transactionSender: ctx?.get('transactionSender') ?? null,
      agentMode: ctx?.get('agentMode') ?? 'public',
      agentAssetAddress: ctx?.get('agentAssetAddress') ?? null,
      agentTokenMint: ctx?.get('agentTokenMint') ?? null,
      agentFeeSol: ctx?.get('agentFeeSol') ?? 0.001,
      tokenOverride: ctx?.get('tokenOverride') ?? null,
    };
    const umi = createUmi();

    // In public mode, use a NoopSigner for the connected wallet (they sign on frontend).
    // In autonomous mode, umi.identity is already the agent's keypair.
    const source = context.agentMode === 'public' && context.walletAddress
      ? createNoopSigner(publicKey(context.walletAddress))
      : umi.identity;

    const builder = transferSolIx(umi, {
      source,
      destination: publicKey(destination),
      amount: sol(amount),
    });

    const result = await submitOrSend(umi, builder, context, {
      message: `Transfer ${amount} SOL to ${destination}`,
    });

    if (result === 'sent-to-wallet') {
      return {
        status: 'pending',
        message: `Transaction sent to your wallet for signing. Please approve the transfer of ${amount} SOL to ${destination}.`,
      };
    }

    return {
      status: 'confirmed',
      signature: result,
      message: `Successfully transferred ${amount} SOL to ${destination}. Signature: ${result}`,
    };
  },
});
