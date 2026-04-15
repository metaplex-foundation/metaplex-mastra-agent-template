import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey } from '@metaplex-foundation/umi';
import {
  registerExecutiveV1,
  delegateExecutionV1,
  findAgentIdentityV1Pda,
  findExecutiveProfileV1Pda,
} from '@metaplex-foundation/mpl-agent-registry';
import { createUmi, getAgentPda } from '@metaplex-agent/shared';
import bs58 from 'bs58';

export const delegateExecution = createTool({
  id: 'delegate-execution',
  description:
    'Set up execution delegation so this agent can sign transactions via its asset signer PDA. Must be called after register-agent. Creates an executive profile and links it to the agent asset.',
  inputSchema: z.object({
    agentAssetAddress: z
      .string()
      .describe('The agent asset address from register-agent output'),
  }),
  outputSchema: z.object({
    executiveProfile: z.string(),
    agentPda: z.string(),
    signature: z.string(),
    message: z.string(),
  }),
  execute: async ({ agentAssetAddress }) => {
    try {
      const umi = createUmi();
      const assetPubkey = publicKey(agentAssetAddress);

      // 1. Register executive profile for this keypair
      await registerExecutiveV1(umi, {
        payer: umi.payer,
      }).sendAndConfirm(umi);

      // 2. Derive PDAs
      const agentIdentity = findAgentIdentityV1Pda(umi, {
        asset: assetPubkey,
      });
      const executiveProfile = findExecutiveProfileV1Pda(umi, {
        authority: umi.identity.publicKey,
      });

      // 3. Delegate execution
      const delegateResult = await delegateExecutionV1(umi, {
        agentAsset: assetPubkey,
        agentIdentity,
        executiveProfile,
      }).sendAndConfirm(umi);

      // 4. Get the agent's operational PDA
      const agentPda = getAgentPda(umi, assetPubkey);
      const signatureStr = bs58.encode(delegateResult.signature);

      return {
        executiveProfile: executiveProfile[0].toString(),
        agentPda: agentPda.toString(),
        signature: signatureStr,
        message: `Execution delegated. Your agent PDA (operational wallet) is: ${agentPda.toString()}. Fund this address with SOL to start operating.`,
      };
    } catch (error) {
      return {
        executiveProfile: '',
        agentPda: '',
        signature: '',
        message: `Delegation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});
