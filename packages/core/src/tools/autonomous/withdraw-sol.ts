import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createNoopSigner, publicKey, sol } from '@metaplex-foundation/umi';
import { transferSol as transferSolIx } from '@metaplex-foundation/mpl-toolbox';
import {
  BASE58_ADDRESS_RE,
  createUmi,
  err,
  getAgentPda,
  ok,
  readAgentContext,
  submitAsAgent,
  submitOrSend,
  toToolError,
} from '@metaplex-foundation/shared';

export const withdrawSol = createTool({
  id: 'withdraw-sol',
  description:
    "Send SOL from the agent to a destination address. " +
    "Default source='pda' — the agent's real wallet (asset signer PDA, signed via Core Execute CPI). " +
    "Use source='keypair' only to drain the operational hot wallet (umi.identity, where gas/swaps come from). " +
    "The agent signs and submits the transaction itself.",
  inputSchema: z.object({
    source: z
      .enum(['pda', 'keypair'])
      .describe(
        "'pda' (default) = the agent's wallet — asset signer PDA, registry-tracked. " +
        "'keypair' = hot wallet only. Pick this only when explicitly draining gas funds.",
      ),
    destination: z
      .string()
      .regex(BASE58_ADDRESS_RE, 'destination must be a valid base58 Solana address')
      .describe('Recipient Solana wallet address'),
    amount: z
      .number()
      .finite()
      .positive()
      .describe('Amount of SOL to withdraw'),
  }),
  outputSchema: z.object({
    status: z.string().optional(),
    code: z.string().optional(),
    signature: z.string().optional(),
    source: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async ({ source, destination, amount }, { requestContext }) => {
    const context = readAgentContext(requestContext);

    try {
      const umi = createUmi();
      const dest = publicKey(destination);

      if (source === 'keypair') {
        const builder = transferSolIx(umi, {
          source: umi.identity,
          destination: dest,
          amount: sol(amount),
        });
        const signature = await submitOrSend(umi, builder, context, {
          message: `Withdraw ${amount} SOL (keypair) → ${destination}`,
        });
        return ok({
          signature,
          source: umi.identity.publicKey.toString(),
          message: `Withdrew ${amount} SOL from keypair to ${destination}. Signature: ${signature}`,
        });
      }

      // source === 'pda'
      if (!context.agentAssetAddress) {
        return err(
          'INVALID_INPUT',
          "Agent is not registered, so no asset signer PDA exists. Use source='keypair' or register the agent first.",
        );
      }
      const pda = getAgentPda(umi, publicKey(context.agentAssetAddress));
      const inner = transferSolIx(umi, {
        // Inner ix's source must be a Signer-shaped value for the builder,
        // but the actual signing obligation is fulfilled by the Core Execute
        // CPI — the PDA cannot sign client-side. The noop signer is a
        // placeholder; submitAsAgent wraps and signs with umi.identity.
        source: createNoopSigner(pda),
        destination: dest,
        amount: sol(amount),
      });
      const signature = await submitAsAgent(
        umi,
        publicKey(context.agentAssetAddress),
        inner,
        context,
      );
      return ok({
        signature,
        source: pda.toString(),
        message: `Withdrew ${amount} SOL from PDA to ${destination}. Signature: ${signature}`,
      });
    } catch (error) {
      console.error('[withdraw-sol]', error);
      const { code, message } = toToolError(error);
      return err(code, `Withdraw failed: ${message}`);
    }
  },
});
