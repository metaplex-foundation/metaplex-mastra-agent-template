import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  publicKey,
  sol,
  createNoopSigner,
} from '@metaplex-foundation/umi';
import { transferSol as transferSolIx } from '@metaplex-foundation/mpl-toolbox';
import {
  BASE58_ADDRESS_RE,
  createUmi,
  err,
  ok,
  readAgentContext,
  submitOrSend,
  toToolError,
} from '@metaplex-agent/shared';

export const transferSol = createTool({
  id: 'transfer-sol',
  description:
    "Transfer SOL from the connected user wallet to a destination address. The transaction is sent to the user's wallet for signing.",
  inputSchema: z.object({
    destination: z
      .string()
      .regex(BASE58_ADDRESS_RE, 'destination must be a valid base58 Solana address')
      .describe('The recipient Solana wallet address'),
    amount: z
      .number()
      .finite()
      .positive()
      .describe('Amount of SOL to transfer'),
  }),
  outputSchema: z.object({
    status: z.string().optional(),
    code: z.string().optional(),
    signature: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async ({ destination, amount }, { requestContext }) => {
    const context = readAgentContext(requestContext);

    try {
      if (!context.walletAddress) {
        return err(
          'INVALID_INPUT',
          'No wallet connected. Ask the user to connect a wallet before initiating a transfer.',
        );
      }

      const umi = createUmi();
      const source = createNoopSigner(publicKey(context.walletAddress));

      const builder = transferSolIx(umi, {
        source,
        destination: publicKey(destination),
        amount: sol(amount),
      });

      const signature = await submitOrSend(umi, builder, context, {
        message: `Transfer ${amount} SOL to ${destination}`,
      });

      return ok({
        signature,
        message: `Successfully transferred ${amount} SOL to ${destination}. Signature: ${signature}`,
      });
    } catch (error) {
      console.error('[transfer-sol]', error);
      const { code, message } = toToolError(error);
      return err(code, `Transfer failed: ${message}`);
    }
  },
});
