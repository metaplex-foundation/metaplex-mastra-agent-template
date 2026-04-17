import {
  type Umi,
  type TransactionBuilder,
  createNoopSigner,
  publicKey as toPublicKey,
  sol,
} from '@metaplex-foundation/umi';
import { base64 } from '@metaplex-foundation/umi/serializers';
import { findAssetSignerPda } from '@metaplex-foundation/mpl-core';
import { transferSol } from '@metaplex-foundation/mpl-toolbox';
import { getConfig } from './config.js';
import type { AgentContext } from './types/agent.js';
import bs58 from 'bs58';

/**
 * Submits a transaction based on the agent mode.
 *
 * - **Public mode**: serialize to base64, send to the user's wallet via
 *   `transactionSender.sendAndAwait`, and return the confirmed signature once
 *   the user approves and signs. Throws if the user rejects, the approval
 *   times out, or the client disconnects.
 *
 * - **Autonomous mode**: sign with the agent keypair and submit directly to
 *   the Solana network; returns the signature.
 *
 * @returns the base58 transaction signature
 */
export async function submitOrSend(
  umi: Umi,
  builder: TransactionBuilder,
  context: AgentContext,
  options?: { message?: string; index?: number; total?: number }
): Promise<string> {
  const config = getConfig();

  if (config.AGENT_MODE === 'public') {
    if (!context.transactionSender) {
      throw new Error('No transaction sender available. Is the WebSocket server running?');
    }
    if (!context.walletAddress) {
      throw new Error('No wallet connected. Ask the user to connect their wallet first.');
    }

    const walletSigner = createNoopSigner(toPublicKey(context.walletAddress));

    // Prepend fee if agent is registered
    let feeSol: number | undefined;
    if (context.agentAssetAddress && context.agentFeeSol > 0) {
      const agentPda = findAssetSignerPda(umi, {
        asset: toPublicKey(context.agentAssetAddress),
      })[0];
      builder = transferSol(umi, {
        source: walletSigner,
        destination: agentPda,
        amount: sol(context.agentFeeSol),
      }).add(builder);
      feeSol = context.agentFeeSol;
    }

    const tx = await builder
      .setFeePayer(walletSigner)
      .buildAndSign(umi);

    const serialized = umi.transactions.serialize(tx);
    const txBase64 = base64.deserialize(serialized)[0];

    // Send to frontend and await user signature
    const signature = await context.transactionSender.sendAndAwait(txBase64, {
      message: options?.message,
      index: options?.index,
      total: options?.total,
      feeSol,
    });

    return signature;
  }

  // Autonomous mode: sign and submit
  const result = await builder.sendAndConfirm(umi);
  return bs58.encode(result.signature);
}
