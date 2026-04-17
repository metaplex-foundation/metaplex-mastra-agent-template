import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import type { ServerMessage } from '@metaplex-agent/shared';

/**
 * Per-WebSocket-connection state.
 *
 * Each session is isolated: wallet address, conversation history, processing flag,
 * pending tx results and chat messages, and in-flight transaction promises all
 * live on the session — never on the server singleton.
 *
 * This prevents cross-session data leakage and the "sticky owner verification"
 * auth-bypass that a global `isOwnerVerified` flag would enable.
 */

export interface PendingTransaction {
  resolve: (signature: string) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface PendingTxResult {
  correlationId: string;
  signature: string;
}

export interface PendingChatMessage {
  content: string;
  senderName?: string;
  isSystem?: boolean;
}

export interface SimpleRateLimiter {
  allow(): boolean;
}

export class Session {
  readonly id: string;
  readonly ws: WebSocket;

  // Identity & auth
  walletAddress: string | null = null;
  isOwnerVerified = false;

  // Conversation
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  // Processing state
  isProcessing = false;
  currentAbortController: AbortController | null = null;

  // Queues for events that arrive mid-processing
  pendingTxResults: PendingTxResult[] = [];
  pendingMessages: PendingChatMessage[] = [];

  // Outstanding transactions awaiting user approval (correlationId → promise handles)
  pendingTransactions: Map<string, PendingTransaction> = new Map();

  // Per-connection health / rate limiting
  aliveCheck: ReturnType<typeof setInterval> | null = null;
  rateLimiter: SimpleRateLimiter;

  constructor(ws: WebSocket, rateLimiter: SimpleRateLimiter) {
    this.ws = ws;
    this.id = randomUUID();
    this.rateLimiter = rateLimiter;
  }

  /**
   * Send a message to this session's client.
   */
  send(msg: ServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Reject all outstanding pending transactions. Called on disconnect or shutdown.
   */
  rejectAllPendingTransactions(reason: string): void {
    for (const [, pending] of this.pendingTransactions) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pendingTransactions.clear();
  }

  /**
   * Abort in-flight agent streaming, clear pending transactions, and stop aliveCheck.
   */
  cleanup(reason: string): void {
    if (this.aliveCheck) {
      clearInterval(this.aliveCheck);
      this.aliveCheck = null;
    }
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    this.rejectAllPendingTransactions(reason);
  }
}
