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
  createUmi,
  submitOrSend,
  type AgentContext,
} from '@metaplex-agent/shared';
import type { RequestContext } from '@mastra/core/request-context';

export const transferToken = createTool({
  id: 'transfer-token',
  description:
    'Transfer SPL tokens from the connected wallet (public mode) or agent wallet (autonomous mode) to a destination address. Automatically creates the destination token account if needed.',
  inputSchema: z.object({
    mint: z.string().describe('The token mint address'),
    destination: z.string().describe('The recipient wallet address'),
    amount: z
      .number()
      .positive()
      .describe(
        'Amount of tokens to transfer in human-readable units (e.g., 100 for 100 tokens)'
      ),
  }),
  outputSchema: z.object({
    status: z.string(),
    signature: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ mint, destination, amount }, { requestContext }) => {
    const ctx = requestContext as RequestContext<AgentContext> | undefined;
    const context: AgentContext = {
      walletAddress: ctx?.get('walletAddress') ?? null,
      transactionSender: ctx?.get('transactionSender') ?? null,
      agentMode: ctx?.get('agentMode') ?? 'public',
      agentAssetAddress: ctx?.get('agentAssetAddress') ?? null,
      agentTokenMint: ctx?.get('agentTokenMint') ?? null,
    };
    const umi = createUmi();

    // In public mode, use a NoopSigner for the connected wallet (they sign on frontend).
    // In autonomous mode, umi.identity is already the agent's keypair.
    const authority = context.agentMode === 'public' && context.walletAddress
      ? createNoopSigner(publicKey(context.walletAddress))
      : umi.identity;

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

    const result = await submitOrSend(umi, builder, context, {
      message: `Transfer ${amount} tokens (${mint}) to ${destination}`,
    });

    if (result === 'sent-to-wallet') {
      return {
        status: 'pending',
        message: `Transaction sent to your wallet for signing. Please approve the transfer of ${amount} tokens to ${destination}.`,
      };
    }

    return {
      status: 'confirmed',
      signature: result,
      message: `Successfully transferred ${amount} tokens to ${destination}. Signature: ${result}`,
    };
  },
});
