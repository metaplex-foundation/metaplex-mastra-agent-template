import {
  type Umi,
  createNoopSigner,
  publicKey as toPublicKey,
  sol,
} from '@metaplex-foundation/umi';
import { transferSol } from '@metaplex-foundation/mpl-toolbox';
import { getConfig } from './config.js';
import { getServerLimits } from './server-limits.js';
import { submitOrSend } from './transaction.js';
import type { AgentContext } from './types/agent.js';

export type FundingResult =
  | { funded: true }
  | { funded: false; reason: string };

/**
 * Ensure the agent keypair has enough SOL to pay for registration / delegation.
 *
 * This helper is mode-aware so that callers (register-agent, delegation tools,
 * etc.) don't have to branch on `AGENT_MODE` themselves:
 *
 * - If the balance is already above the funding threshold: returns immediately.
 * - In public mode with a connected user wallet: requests a small top-up from
 *   the user, awaits their signature, and polls until the confirmed balance
 *   clears the threshold.
 * - In autonomous mode, or public mode with no connected wallet: returns a
 *   `funded: false` result carrying the exact address and amount the operator
 *   needs to fund manually. The caller translates this to a tool error.
 *
 * The mode check lives here, at the funding-policy seam — not inside each
 * consumer tool.
 */
export async function ensureAgentFunded(
  umi: Umi,
  ctx: AgentContext,
): Promise<FundingResult> {
  const config = getConfig();
  const limits = getServerLimits();
  const fundingSol = limits.AGENT_FUNDING_SOL;
  const fundingThresholdSol = limits.AGENT_FUNDING_THRESHOLD_SOL;

  const balance = await umi.rpc.getBalance(umi.identity.publicKey, {
    commitment: 'confirmed',
  });
  const balanceSol = Number(balance.basisPoints) / 1e9;

  if (balanceSol >= fundingThresholdSol) {
    return { funded: true };
  }

  const agentAddress = umi.identity.publicKey;
  const canAutoFund =
    config.AGENT_MODE === 'public' && ctx.walletAddress && ctx.transactionSender;

  if (!canAutoFund) {
    return {
      funded: false,
      reason: `Agent keypair has insufficient SOL for on-chain operations (${balanceSol.toFixed(4)} SOL). Please send at least ${fundingSol} SOL to: ${agentAddress}`,
    };
  }

  const walletSigner = createNoopSigner(toPublicKey(ctx.walletAddress!));
  const builder = transferSol(umi, {
    source: walletSigner,
    destination: agentAddress,
    amount: sol(fundingSol),
  });

  // Build a minimal funding context — we explicitly zero the fee so the
  // registration top-up itself doesn't try to prepend another fee transfer.
  const fundingContext: AgentContext = {
    walletAddress: ctx.walletAddress,
    transactionSender: ctx.transactionSender,
    agentMode: 'public',
    agentAssetAddress: null,
    agentTokenMint: ctx.agentTokenMint,
    agentFeeSol: 0,
    tokenOverride: ctx.tokenOverride,
    ownerWallet: ctx.ownerWallet,
  };

  await submitOrSend(umi, builder, fundingContext, {
    message: `Fund agent keypair (${fundingSol} SOL)`,
  });

  // Poll for the confirmed balance so the caller can proceed in the same call.
  for (let i = 0; i < 10; i++) {
    const updated = await umi.rpc.getBalance(umi.identity.publicKey, {
      commitment: 'confirmed',
    });
    if (Number(updated.basisPoints) / 1e9 >= fundingThresholdSol) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  return { funded: true };
}
