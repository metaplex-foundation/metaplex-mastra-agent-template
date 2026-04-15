import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey } from '@metaplex-foundation/umi';
import {
  createAndRegisterLaunch,
  type BondingCurveLaunchInput,
  type SvmNetwork,
} from '@metaplex-foundation/genesis';
import { createUmi, getConfig, setState, type AgentContext } from '@metaplex-agent/shared';
import type { RequestContext } from '@mastra/core/request-context';

export const launchToken = createTool({
  id: 'launch-token',
  description:
    'Launch an agent token on a bonding curve via Metaplex Genesis. WARNING: This is irreversible — each agent can only ever have one token. Always confirm with the user before calling this tool.',
  inputSchema: z.object({
    name: z.string().min(1).max(32).describe('Token name (1-32 characters)'),
    symbol: z.string().min(1).max(10).describe('Token symbol (1-10 characters)'),
    imageUri: z.string().url().describe('Token image URL (must be an Irys URL)'),
    description: z
      .string()
      .max(250)
      .optional()
      .describe('Token description (max 250 characters)'),
    firstBuyAmount: z
      .number()
      .positive()
      .optional()
      .describe('SOL amount for an initial fee-free token purchase'),
  }),
  outputSchema: z.object({
    mintAddress: z.string(),
    launchLink: z.string(),
    message: z.string(),
  }),
  execute: async (
    { name, symbol, imageUri, description, firstBuyAmount },
    { requestContext }
  ) => {
    const ctx = requestContext as RequestContext<AgentContext> | undefined;
    const agentAssetAddress = ctx?.get('agentAssetAddress');

    if (!agentAssetAddress) {
      return {
        mintAddress: '',
        launchLink: '',
        message: 'Agent must be registered first. Use register-agent and delegate-execution before launching a token.',
      };
    }

    const existingMint = ctx?.get('agentTokenMint');
    if (existingMint) {
      return {
        mintAddress: existingMint,
        launchLink: '',
        message: `Agent already has a token: ${existingMint}. Each agent can only have one token.`,
      };
    }

    const tokenOverride = ctx?.get('tokenOverride');
    if (tokenOverride) {
      return {
        mintAddress: '',
        launchLink: '',
        message: `TOKEN_OVERRIDE is set to ${tokenOverride}. This agent is configured to buy back an existing token instead of launching its own.`,
      };
    }

    try {
      const config = getConfig();
      const umi = createUmi();

      let network: SvmNetwork = 'solana-mainnet';
      if (config.SOLANA_RPC_URL.includes('devnet')) {
        network = 'solana-devnet';
      }

      const launchConfig: BondingCurveLaunchInput = {};
      if (firstBuyAmount !== undefined) {
        launchConfig.firstBuyAmount = firstBuyAmount;
      }

      const result = await createAndRegisterLaunch(
        umi,
        {},
        {
          wallet: umi.identity.publicKey,
          agent: {
            mint: publicKey(agentAssetAddress),
            setToken: true,
          },
          launchType: 'bondingCurve',
          network,
          token: {
            name,
            symbol,
            image: imageUri,
            ...(description ? { description } : {}),
          },
          launch: launchConfig,
        }
      );

      setState({ agentTokenMint: result.mintAddress });

      return {
        mintAddress: result.mintAddress,
        launchLink: result.launch.link,
        message: `Token launched! Mint: ${result.mintAddress}. This has been saved automatically. Creator fees will flow to your agent PDA automatically.`,
      };
    } catch (error) {
      return {
        mintAddress: '',
        launchLink: '',
        message: `Token launch failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});
