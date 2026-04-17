import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { mintAndSubmitAgent } from '@metaplex-foundation/mpl-agent-registry';
import type { SvmNetwork } from '@metaplex-foundation/mpl-agent-registry';
import {
  createNoopSigner,
  publicKey as toPublicKey,
  sol,
} from '@metaplex-foundation/umi';
import { transferSol } from '@metaplex-foundation/mpl-toolbox';
import {
  createUmi,
  err,
  getConfig,
  getServerLimits,
  info,
  ok,
  setState,
  updateConfigFromState,
  clearOwnerCache,
  submitOrSend,
  toToolError,
  type AgentContext,
  type ToolResult,
} from '@metaplex-agent/shared';
import type { RequestContext } from '@mastra/core/request-context';
import { base58 } from '@metaplex-foundation/umi/serializers';

/**
 * Module-scoped single-flight guard (H4). If a registration is already in
 * progress, concurrent callers await the same promise and observe the same
 * result instead of each starting an independent funding+mint flow. The
 * entry is cleared in a `finally` so subsequent (retry) calls start fresh.
 */
let inflightRegistration: Promise<ToolResult<Record<string, unknown>>> | null = null;

export const registerAgent = createTool({
  id: 'register-agent',
  description:
    'Register this agent on the Metaplex Agent Registry. Creates an MPL Core asset and Agent Identity PDA. Only needs to be called once — check if AGENT_ASSET_ADDRESS is already set before calling.',
  inputSchema: z.object({
    name: z.string().min(1).describe('Display name for the agent'),
    description: z.string().min(1).describe('Description of the agent capabilities'),
    metadataUri: z
      .string()
      .url()
      .optional()
      .describe('Publicly hosted JSON metadata URI. If not provided, a placeholder will be used.'),
  }),
  outputSchema: z.object({
    status: z.string().optional(),
    code: z.string().optional(),
    assetAddress: z.string().optional(),
    signature: z.string().optional(),
    message: z.string().optional(),
    fundingRequested: z.boolean().optional(),
  }),
  execute: async ({ name, description, metadataUri }, { requestContext }) => {
    const ctx = requestContext as RequestContext<AgentContext> | undefined;
    const existingAsset = ctx?.get('agentAssetAddress');
    if (existingAsset) {
      return info({
        assetAddress: existingAsset,
        message: `Agent is already registered with asset address: ${existingAsset}`,
      });
    }

    if (inflightRegistration) {
      return inflightRegistration;
    }

    const run = async (): Promise<ToolResult<Record<string, unknown>>> => {
      try {
        const config = getConfig();
        const limits = getServerLimits();
        const fundingSol = limits.AGENT_FUNDING_SOL;
        const fundingThresholdSol = limits.AGENT_FUNDING_THRESHOLD_SOL;
        const umi = createUmi();

        // Check agent keypair balance before attempting registration
        const balance = await umi.rpc.getBalance(umi.identity.publicKey, { commitment: 'confirmed' });
        const balanceSol = Number(balance.basisPoints) / 1e9;

        if (balanceSol < fundingThresholdSol) {
          const agentAddress = umi.identity.publicKey;

          // Public mode with wallet connected: send funding tx to user and await
          // signature, then continue directly to registration in the same call.
          if (config.AGENT_MODE === 'public' && ctx?.get('walletAddress') && ctx?.get('transactionSender')) {
            const walletAddress = ctx.get('walletAddress')!;
            const walletSigner = createNoopSigner(toPublicKey(walletAddress));

            const builder = transferSol(umi, {
              source: walletSigner,
              destination: agentAddress,
              amount: sol(fundingSol),
            });

            const context: AgentContext = {
              walletAddress,
              transactionSender: ctx.get('transactionSender'),
              agentMode: 'public',
              agentAssetAddress: null,
              agentTokenMint: ctx.get('agentTokenMint') ?? null,
              agentFeeSol: 0,
              tokenOverride: ctx.get('tokenOverride') ?? null,
              ownerWallet: ctx.get('ownerWallet') ?? null,
            };

            // This awaits the user's signature (and confirmation from the frontend)
            await submitOrSend(umi, builder, context, {
              message: `Fund agent keypair for registration (${fundingSol} SOL)`,
            });

            // Poll briefly for the funded balance to be visible before proceeding
            for (let i = 0; i < 10; i++) {
              const updated = await umi.rpc.getBalance(umi.identity.publicKey, { commitment: 'confirmed' });
              if (Number(updated.basisPoints) / 1e9 >= fundingThresholdSol) break;
              await new Promise((r) => setTimeout(r, 1000));
            }
            // fall through to registration
          } else {
            // No wallet or autonomous mode: tell user to fund manually
            return err(
              'INSUFFICIENT_FUNDS',
              `Agent keypair has insufficient SOL for registration (${balanceSol.toFixed(4)} SOL). Please send at least ${fundingSol} SOL to: ${agentAddress}`,
            );
          }
        }

        let network: SvmNetwork = 'solana-mainnet';
        if (config.SOLANA_RPC_URL.includes('devnet')) {
          network = 'solana-devnet';
        }

        const result = await mintAndSubmitAgent(umi, {}, {
          wallet: umi.identity.publicKey,
          name,
          uri: metadataUri ?? 'https://example.com/agent-metadata.json',
          network,
          agentMetadata: {
            type: 'agent',
            name,
            description,
            services: [],
            registrations: [],
            supportedTrust: [],
          },
        });

        const signatureStr = base58.deserialize(result.signature)[0];

        setState({ agentAssetAddress: result.assetAddress });
        updateConfigFromState();
        clearOwnerCache();

        return ok({
          assetAddress: result.assetAddress,
          signature: signatureStr,
          message: `Agent registered successfully! Asset address: ${result.assetAddress}. This has been saved automatically.`,
        });
      } catch (error) {
        console.error('[register-agent]', error);
        const { code, message } = toToolError(error);
        return err(code, `Registration failed: ${message}`);
      }
    };

    inflightRegistration = run();
    try {
      return await inflightRegistration;
    } finally {
      inflightRegistration = null;
    }
  },
});
