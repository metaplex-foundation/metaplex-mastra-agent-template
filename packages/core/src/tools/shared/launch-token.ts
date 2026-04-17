import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey } from '@metaplex-foundation/umi';
import {
  createAndRegisterLaunch,
  type BondingCurveLaunchInput,
  type SvmNetwork,
} from '@metaplex-foundation/genesis';
import {
  createUmi,
  err,
  getConfig,
  info,
  ok,
  setState,
  toToolError,
  updateConfigFromState,
  type AgentContext,
} from '@metaplex-agent/shared';
import type { RequestContext } from '@mastra/core/request-context';

export const launchToken = createTool({
  id: 'launch-token',
  description:
    'Launch an agent token on a bonding curve via Metaplex Genesis. WARNING: This is irreversible — each agent can only ever have one token. The agent pays and signs in both public and autonomous modes. Always confirm with the user before calling this tool, and pass `confirmIrreversible: true` to acknowledge the irreversible action.',
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
    confirmIrreversible: z
      .literal(true)
      .describe(
        'Must be set to `true` to confirm the caller understands that launching a token is irreversible and each agent can only ever have one token. Never pass `true` without explicit user confirmation.',
      ),
  }),
  outputSchema: z.object({
    status: z.string().optional(),
    code: z.string().optional(),
    mintAddress: z.string().optional(),
    launchLink: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async (
    { name, symbol, imageUri, description, firstBuyAmount, confirmIrreversible },
    { requestContext }
  ) => {
    // Belt-and-braces: Zod enforces `literal(true)` at parse time, but if a
    // client somehow bypassed that we still refuse to proceed.
    if (confirmIrreversible !== true) {
      return err(
        'INVALID_INPUT',
        'launch-token requires explicit user confirmation via `confirmIrreversible: true`. Refusing to launch.',
      );
    }

    const ctx = requestContext as RequestContext<AgentContext> | undefined;
    const agentAssetAddress = ctx?.get('agentAssetAddress');

    if (!agentAssetAddress) {
      return err(
        'NOT_REGISTERED',
        'Agent must be registered first. Use register-agent and delegate-execution before launching a token.',
      );
    }

    const existingMint = ctx?.get('agentTokenMint');
    if (existingMint) {
      return info({
        mintAddress: existingMint,
        message: `Agent already has a token: ${existingMint}. Each agent can only have one token.`,
      });
    }

    const tokenOverride = ctx?.get('tokenOverride');
    if (tokenOverride) {
      return info({
        mintAddress: tokenOverride,
        message: `TOKEN_OVERRIDE is set to ${tokenOverride}. This agent is configured to buy back an existing token instead of launching its own.`,
      });
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
      updateConfigFromState();

      return ok({
        mintAddress: result.mintAddress,
        launchLink: result.launch.link,
        message: `Token launched! Mint: ${result.mintAddress}. This has been saved automatically. Creator fees will flow to your agent PDA automatically.`,
      });
    } catch (error) {
      console.error('[launch-token]', error);
      const { code, message } = toToolError(error);
      return err(code, `Token launch failed: ${message}`);
    }
  },
});
