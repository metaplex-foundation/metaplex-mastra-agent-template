import {
  type Umi,
  type TransactionBuilder,
  createNoopSigner,
  publicKey as toPublicKey,
} from '@metaplex-foundation/umi';
import { base64 } from '@metaplex-foundation/umi/serializers';
import { getConfig } from './config.js';
import type { AgentContext } from './types/agent.js';
import bs58 from 'bs58';

/**
 * Submits a transaction based on the agent mode:
 *
 * - **Public mode**: Serializes the transaction to base64 and sends it to the
 *   connected frontend wallet for signing via the TransactionSender.
 *
 * - **Autonomous mode**: Signs with the agent keypair and submits directly to
 *   the Solana network.
 *
 * @param umi - The configured Umi instance
 * @param builder - A TransactionBuilder with instructions ready to go
 * @param context - Agent context with wallet address and transaction sender
 * @param options - Optional message and multi-transaction index/total
 * @returns Transaction signature (autonomous mode) or "sent-to-wallet" (public mode)
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

    // Use a noop signer for the user's wallet -- they'll sign on the frontend
    const walletSigner = createNoopSigner(toPublicKey(context.walletAddress));

    // Build the transaction with the user as fee payer
    const tx = await builder
      .setFeePayer(walletSigner)
      .buildAndSign(umi);

    // Serialize to base64
    const serialized = umi.transactions.serialize(tx);
    const txBase64 = base64.deserialize(serialized)[0];

    // Send to frontend via WebSocket
    context.transactionSender.sendTransaction({
      type: 'transaction',
      transaction: txBase64,
      message: options?.message,
      index: options?.index,
      total: options?.total,
    });

    return 'sent-to-wallet';
  }

  // Autonomous mode: sign and submit
  const result = await builder.sendAndConfirm(umi);
  // Convert signature bytes to base58 string
  const signature = bs58.encode(result.signature);
  return signature;
}
