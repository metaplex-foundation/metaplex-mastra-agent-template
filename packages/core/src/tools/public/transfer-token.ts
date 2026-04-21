import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  publicKey,
  transactionBuilder,
  createNoopSigner,
} from '@metaplex-foundation/umi';
import {
  transferTokens,
  findAssociatedTokenPda,
  createTokenIfMissing,
  fetchMint,
} from '@metaplex-foundation/mpl-toolbox';
import {
  BASE58_ADDRESS_RE,
  createUmi,
  err,
  ok,
  readAgentContext,
  submitOrSend,
  toToolError,
} from '@metaplex-agent/shared';

export const transferToken = createTool({
  id: 'transfer-token',
  description:
    "Transfer SPL tokens from the connected user wallet to a destination address. Auto-creates the destination token account if needed. The transaction is sent to the user's wallet for signing.",
  inputSchema: z.object({
    mint: z
      .string()
      .regex(BASE58_ADDRESS_RE, 'mint must be a valid base58 Solana address')
      .describe('The token mint address'),
    destination: z
      .string()
      .regex(BASE58_ADDRESS_RE, 'destination must be a valid base58 Solana address')
      .describe('The recipient wallet address'),
    amount: z
      .number()
      .finite()
      .positive()
      .describe(
        'Amount of tokens to transfer in human-readable units (e.g., 100 for 100 tokens)'
      ),
  }),
  outputSchema: z.object({
    status: z.string().optional(),
    code: z.string().optional(),
    signature: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async ({ mint, destination, amount }, { requestContext }) => {
    const context = readAgentContext(requestContext);

    try {
      if (!context.walletAddress) {
        return err(
          'INVALID_INPUT',
          'No wallet connected. Ask the user to connect a wallet before initiating a transfer.',
        );
      }

      const umi = createUmi();
      const authority = createNoopSigner(publicKey(context.walletAddress));

      const mintPk = publicKey(mint);
      const destOwner = publicKey(destination);
      const sourceOwner = authority.publicKey;

      // Fetch mint to get decimals for converting human-readable amount
      const mintAccount = await fetchMint(umi, mintPk);
      const rawAmount = BigInt(
        Math.round(amount * Math.pow(10, mintAccount.decimals))
      );

      const [sourceAta] = findAssociatedTokenPda(umi, {
        mint: mintPk,
        owner: sourceOwner,
      });
      const [destinationAta] = findAssociatedTokenPda(umi, {
        mint: mintPk,
        owner: destOwner,
      });

      const builder = transactionBuilder()
        .add(createTokenIfMissing(umi, { mint: mintPk, owner: destOwner }))
        .add(
          transferTokens(umi, {
            source: sourceAta,
            destination: destinationAta,
            authority,
            amount: rawAmount,
          })
        );

      const signature = await submitOrSend(umi, builder, context, {
        message: `Transfer ${amount} tokens (${mint}) to ${destination}`,
      });

      return ok({
        signature,
        message: `Successfully transferred ${amount} tokens to ${destination}. Signature: ${signature}`,
      });
    } catch (error) {
      console.error('[transfer-token]', error);
      const { code, message } = toToolError(error);
      return err(code, `Transfer failed: ${message}`);
    }
  },
});
