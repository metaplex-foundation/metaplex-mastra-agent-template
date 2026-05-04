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
  err,
  getAgentPda,
  ok,
  readAgentContext,
  submitWithUserWallet,
  toToolError,
} from '@metaplex-agent/shared';

export const fundAgentSol = createTool({
  id: 'fund-agent-sol',
  description:
    "Send SOL from the connected user wallet to the agent. " +
    "Default target='pda' — the agent's real wallet (asset signer PDA, registry-tracked). " +
    "Only use target='keypair' to top up the operational hot wallet that pays gas (e.g. before registration, or when keypair SOL is too low for gas). " +
    "The transaction is sent to the user's wallet for signing.",
  inputSchema: z.object({
    target: z
      .enum(['pda', 'keypair'])
      .describe(
        "'pda' (default) = the agent's wallet — the asset signer PDA, registry-tracked treasury. " +
        "'keypair' = hot wallet for gas/swaps only. Pick this only for gas top-ups or before registration.",
      ),
    amount: z
      .number()
      .finite()
      .positive()
      .describe('Amount of SOL to send'),
  }),
  outputSchema: z.object({
    status: z.string().optional(),
    code: z.string().optional(),
    signature: z.string().optional(),
    destination: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async ({ target, amount }, { requestContext }) => {
    const context = readAgentContext(requestContext);

    try {
      if (!context.walletAddress) {
        return err(
          'INVALID_INPUT',
          'No wallet connected. Ask the user to connect a wallet before funding the agent.',
        );
      }

      const umi = createUmi();
      const source = createNoopSigner(publicKey(context.walletAddress));

      let destination;
      if (target === 'keypair') {
        destination = umi.identity.publicKey;
      } else {
        if (!context.agentAssetAddress) {
          return err(
            'INVALID_INPUT',
            "Agent is not registered yet, so no asset signer PDA exists. Use target='keypair' instead, or register the agent first.",
          );
        }
        destination = getAgentPda(umi, publicKey(context.agentAssetAddress));
      }

      const builder = transferSolIx(umi, {
        source,
        destination,
        amount: sol(amount),
      });

      const signature = await submitWithUserWallet(umi, builder, context, {
        message: `Fund agent (${target}) with ${amount} SOL`,
      });

      return ok({
        signature,
        destination: destination.toString(),
        message: `Funded agent ${target} (${destination.toString()}) with ${amount} SOL. Signature: ${signature}`,
      });
    } catch (error) {
      console.error('[fund-agent-sol]', error);
      const { code, message } = toToolError(error);
      return err(code, `Fund failed: ${message}`);
    }
  },
});
