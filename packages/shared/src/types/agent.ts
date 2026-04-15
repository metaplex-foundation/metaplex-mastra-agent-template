import type { ServerTransaction } from './protocol.js';

/**
 * Interface for sending transactions to connected clients.
 * In public mode, the server injects a real implementation.
 * In autonomous mode, this is never called.
 */
export interface TransactionSender {
  sendTransaction(tx: ServerTransaction): void;
}

/**
 * Context passed to tools during execution.
 * Provides access to the wallet address and transaction sender.
 */
export interface AgentContext {
  walletAddress: string | null;
  transactionSender: TransactionSender | null;
  agentMode: 'public' | 'autonomous';
  agentAssetAddress: string | null;
  agentTokenMint: string | null;
}
