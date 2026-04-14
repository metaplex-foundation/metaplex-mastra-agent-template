import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey, sol } from '@metaplex-foundation/umi';
import { transferSol as transferSolIx } from '@metaplex-foundation/mpl-toolbox';
import {
  createUmi,
  submitOrSend,
  type AgentContext,
} from '@metaplex-agent/shared';

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
    const context = requestContext as unknown as AgentContext;
    const umi = createUmi();

    const builder = transferSolIx(umi, {
      source: umi.identity,
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
