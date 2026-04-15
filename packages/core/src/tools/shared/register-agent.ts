import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { mintAndSubmitAgent } from '@metaplex-foundation/mpl-agent-registry';
import type { SvmNetwork } from '@metaplex-foundation/mpl-agent-registry';
import { createUmi, getConfig, setState, type AgentContext } from '@metaplex-agent/shared';
import type { RequestContext } from '@mastra/core/request-context';
import { base58 } from '@metaplex-foundation/umi/serializers';

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
    assetAddress: z.string(),
    signature: z.string(),
    message: z.string(),
  }),
  execute: async ({ name, description, metadataUri }, { requestContext }) => {
    const ctx = requestContext as RequestContext<AgentContext> | undefined;
    const existingAsset = ctx?.get('agentAssetAddress');
    if (existingAsset) {
      return {
        assetAddress: existingAsset,
        signature: '',
        message: `Agent is already registered with asset address: ${existingAsset}`,
      };
    }

    try {
      const config = getConfig();
      const umi = createUmi();

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

      return {
        assetAddress: result.assetAddress,
        signature: signatureStr,
        message: `Agent registered successfully! Asset address: ${result.assetAddress}. This has been saved automatically.`,
      };
    } catch (error) {
      return {
        assetAddress: '',
        signature: '',
        message: `Registration failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});
