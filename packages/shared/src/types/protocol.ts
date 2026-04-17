// ============================================================================
// PlexChat WebSocket Protocol Types
// ============================================================================

// --- Client -> Server Messages ---

export interface ClientChatMessage {
  type: 'message';
  content: string;
  sender_name?: string;
}

export interface ClientWalletConnect {
  type: 'wallet_connect';
  address: string;
}

export interface ClientWalletDisconnect {
  type: 'wallet_disconnect';
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

export type ClientMessage =
  | ClientChatMessage
  | ClientWalletConnect
  | ClientWalletDisconnect
  | ClientTransactionResult
  | ClientTransactionError;

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

export interface ServerWalletConnected {
  type: 'wallet_connected';
  address: string;
}

export interface ServerWalletDisconnected {
  type: 'wallet_disconnected';
}

export interface ServerError {
  type: 'error';
  error: string;
  code?: string;
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
  | ServerChatMessage
  | ServerTyping
  | ServerTransaction
  | ServerWalletConnected
  | ServerWalletDisconnected
  | ServerError
  | DebugMessage;
