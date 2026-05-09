// ============================================================================
// PlexChat WebSocket Protocol Types
// ============================================================================

// --- Client -> Server Messages ---

export interface ClientAuthResponse {
  type: 'auth_response';
  publicKey: string;
  signature: string;       // base58 Ed25519 signature
  message: string;         // exact UTF-8 string the wallet signed
}

export interface ClientChatMessage {
  type: 'message';
  content: string;
  sender_name?: string;
}

export interface ClientTransactionResult {
  type: 'tx_result';
  correlationId: string;
  signature: string;
}

export interface ClientTransactionError {
  type: 'tx_error';
  correlationId: string;
  reason: string;
}

// --- Owner-only allowlist admin (Sprint 2 #20) ---
//
// Operators running an agent in `allowlist` auth mode otherwise have to
// hand-edit `wallets.allowlist.json` to grant access. These messages let
// the on-chain owner manage the list from the chat UI. All three are
// gated server-side by `isOwnerVerified` — non-owner clients receive a
// `not_authorized` error code.

/** Request a snapshot of the current allowlist (file ∪ env, deduped). */
export interface ClientAllowlistList {
  type: 'allowlist_list';
}

/** Add a base58 pubkey to the allowlist file. Idempotent. */
export interface ClientAllowlistAdd {
  type: 'allowlist_add';
  pubkey: string;
}

/** Remove a base58 pubkey from the allowlist file. Idempotent. */
export interface ClientAllowlistRemove {
  type: 'allowlist_remove';
  pubkey: string;
}

export type ClientMessage =
  | ClientAuthResponse
  | ClientChatMessage
  | ClientTransactionResult
  | ClientTransactionError
  | ClientAllowlistList
  | ClientAllowlistAdd
  | ClientAllowlistRemove;

// --- Server -> Client Messages ---

export interface ServerConnected {
  type: 'connected';
  jid: string;
}

export interface ServerChatMessage {
  type: 'message';
  content: string;
  sender: string;
}

export interface ServerTyping {
  type: 'typing';
  isTyping: boolean;
}

export interface ServerTransaction {
  type: 'transaction';
  transaction: string; // base64-encoded serialized Solana transaction
  correlationId: string; // server-assigned, echoed in tx_result/tx_error
  message?: string;
  index?: number;
  total?: number;
  feeSol?: number; // pre-computed fee included in this tx (public mode)
}

export interface ServerAuthChallenge {
  type: 'auth_challenge';
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  agentName: string;
  agentAsset: string | null;
  network: 'solana-mainnet' | 'solana-devnet';
  authMode: 'owner' | 'allowlist' | 'open';
}

export interface ServerAuthenticated {
  type: 'authenticated';
  walletAddress: string;
  isOwner: boolean;
  sessionId: string;
}

export interface ServerAuthError {
  type: 'auth_error';
  code:
    | 'nonce_expired'
    | 'nonce_invalid'
    | 'message_mismatch'
    | 'signature_invalid'
    | 'not_authorized'
    | 'auth_timeout';
  message: string;
}

export interface ServerError {
  type: 'error';
  error: string;
  code?: string;
}

/**
 * Snapshot of the current allowlist (file ∪ env, deduped). Sent in
 * response to `allowlist_list` and after successful add/remove. Echoed
 * `source` lets the UI show which file the operator should hand-edit if
 * they prefer to bypass the admin (defaults to wallets.allowlist.json).
 */
export interface ServerAllowlistState {
  type: 'allowlist_state';
  /** Base58 pubkeys currently allowed (may include the owner — owner is also always implicitly allowed). */
  wallets: string[];
  /** Echo of the absolute path to the JSON file the server is mutating. */
  filePath: string;
  /** Wallets supplied via the WALLET_ALLOWLIST env var — read-only from the UI. */
  envWallets: string[];
}

/**
 * Targeted error for the allowlist admin protocol. Distinct from the
 * generic `error` shape so the UI can surface it next to the admin panel
 * rather than as a chat-level error.
 */
export interface ServerAllowlistError {
  type: 'allowlist_error';
  /**
   * Coded reason. Only `not_authorized` and `bad_pubkey` are user-visible
   * recovery cases; the others map to "something is broken on the server".
   */
  code:
    | 'not_authorized'
    | 'bad_pubkey'
    | 'wrong_auth_mode'
    | 'file_write_failed'
    | 'env_only'
    | 'internal';
  message: string;
}

// --- Debug Events (Server -> Client) ---

export interface DebugStepStart {
  type: 'debug:step_start';
  step: number;
  stepType: 'initial' | 'tool-result' | 'continue';
}

export interface DebugToolCall {
  type: 'debug:tool_call';
  step: number;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface DebugToolResult {
  type: 'debug:tool_result';
  step: number;
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
  durationMs: number;
}

export interface DebugTextDelta {
  type: 'debug:text_delta';
  step: number;
  delta: string;
}

export interface DebugStepComplete {
  type: 'debug:step_complete';
  step: number;
  finishReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
  };
  durationMs: number;
}

export interface DebugGenerationComplete {
  type: 'debug:generation_complete';
  totalSteps: number;
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
  };
  totalDurationMs: number;
  traceId?: string;
  finishReason: string;
}

export interface DebugContext {
  type: 'debug:context';
  agentMode: string;
  model: string;
  assistantName: string;
  walletAddress: string | null;
  connectedClients: number;
  conversationLength: number;
  tools: string[];
}

export type DebugMessage =
  | DebugStepStart
  | DebugToolCall
  | DebugToolResult
  | DebugTextDelta
  | DebugStepComplete
  | DebugGenerationComplete
  | DebugContext;

export type ServerMessage =
  | ServerConnected
  | ServerAuthChallenge
  | ServerAuthenticated
  | ServerAuthError
  | ServerChatMessage
  | ServerTyping
  | ServerTransaction
  | ServerError
  | ServerAllowlistState
  | ServerAllowlistError
  | DebugMessage;
