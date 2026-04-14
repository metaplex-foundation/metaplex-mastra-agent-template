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

export type ClientMessage =
  | ClientChatMessage
  | ClientWalletConnect
  | ClientWalletDisconnect;

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
  message?: string;
  index?: number;
  total?: number;
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
}

export type ServerMessage =
  | ServerConnected
  | ServerChatMessage
  | ServerTyping
  | ServerTransaction
  | ServerWalletConnected
  | ServerWalletDisconnected
  | ServerError;
