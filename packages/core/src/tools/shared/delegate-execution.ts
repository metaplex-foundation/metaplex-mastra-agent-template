import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey, type Umi, type PublicKey } from '@metaplex-foundation/umi';
import {
  registerExecutiveV1,
  delegateExecutionV1,
  findAgentIdentityV1Pda,
  findExecutiveProfileV1Pda,
  safeFetchExecutiveProfileV1FromSeeds,
  safeFetchExecutionDelegateRecordV1FromSeeds,
} from '@metaplex-foundation/mpl-agent-registry';
import {
  createUmi,
  err,
  getAgentPda,
  info,
  ok,
  toToolError,
} from '@metaplex-agent/shared';
import { base58 } from '@metaplex-foundation/umi/serializers';

const MAX_POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 500;
const MAX_SEND_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

/**
 * Poll until an account exists on-chain at confirmed commitment.
 * Returns true once the account is found, false if it times out.
 */
async function waitForAccount(umi: Umi, address: PublicKey): Promise<boolean> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const account = await umi.rpc.getAccount(address, { commitment: 'confirmed' });
    if (account.exists) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

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
    status: z.string().optional(),
    code: z.string().optional(),
    executiveProfile: z.string().optional(),
    agentPda: z.string().optional(),
    signature: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async ({ agentAssetAddress }) => {
    try {
      const umi = createUmi();
      const assetPubkey = publicKey(agentAssetAddress);

      // Wait for the asset to be confirmed on-chain before doing anything.
      // This prevents simulation failures when register-agent just completed.
      const assetReady = await waitForAccount(umi, assetPubkey);
      if (!assetReady) {
        return err(
          'NOT_FOUND',
          `Asset ${agentAssetAddress} not found on-chain after ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s. Registration may not have confirmed yet — please try again.`,
        );
      }

      // Derive PDAs
      const executiveProfile = findExecutiveProfileV1Pda(umi, {
        authority: umi.identity.publicKey,
      });
      const agentIdentity = findAgentIdentityV1Pda(umi, { asset: assetPubkey });
      const agentPda = getAgentPda(umi, assetPubkey);

      // Check existing state in parallel
      const commitment = { commitment: 'confirmed' as const };
      const [existingProfile, existingDelegate] = await Promise.all([
        safeFetchExecutiveProfileV1FromSeeds(umi, {
          authority: umi.identity.publicKey,
        }, commitment),
        safeFetchExecutionDelegateRecordV1FromSeeds(umi, {
          executiveProfile: executiveProfile[0],
          agentAsset: assetPubkey,
        }, commitment),
      ]);

      if (existingProfile && existingDelegate) {
        return info({
          executiveProfile: executiveProfile[0].toString(),
          agentPda: agentPda.toString(),
          message: `Execution already delegated. Agent PDA wallet: ${agentPda.toString()}`,
        });
      }

      // Bundle only the needed instructions
      const delegateIx = delegateExecutionV1(umi, {
        agentAsset: assetPubkey,
        agentIdentity,
        executiveProfile,
      });
      const builder = existingProfile
        ? delegateIx
        : registerExecutiveV1(umi, { payer: umi.payer }).add(delegateIx);

      // Send with retries — the RPC simulation layer can lag behind confirmed state
      let lastError: unknown;
      for (let attempt = 0; attempt < MAX_SEND_RETRIES; attempt++) {
        try {
          const result = await builder.sendAndConfirm(umi, {
            confirm: { commitment: 'confirmed' },
            send: { skipPreflight: true },
          });
          const signatureStr = base58.deserialize(result.signature)[0];
          return ok({
            executiveProfile: executiveProfile[0].toString(),
            agentPda: agentPda.toString(),
            signature: signatureStr,
            message: `Execution delegated successfully. Agent PDA wallet: ${agentPda.toString()}`,
          });
        } catch (e) {
          lastError = e;
          if (attempt < MAX_SEND_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          }
        }
      }

      console.error('[delegate-execution] retries exhausted:', lastError);
      const retryErr = toToolError(lastError);
      return err(
        retryErr.code,
        `Delegation failed after ${MAX_SEND_RETRIES} attempts: ${retryErr.message}`,
      );
    } catch (error) {
      console.error('[delegate-execution]', error);
      const { code, message } = toToolError(error);
      return err(code, `Delegation failed: ${message}`);
    }
  },
});
