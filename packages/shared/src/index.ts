// Local runtime modules (env, file IO, banner — host-specific, not in toolkit).
export * from './config.js';
export * from './state.js';
export * from './umi.js';
export * from './funding.js';
export * from './server-limits.js';
export * from './paas.js';
export * from './registration-banner.js';
export * from './agent-config.js';
export * from './allowlist-file.js';
export * from './owner-resolution.js';
export * from './tool-host-context.js';

// Re-export the toolkit's runtime helpers (auth wrapper, context types,
// tx helpers, etc.) so existing consumers of `@metaplex-foundation/shared`
// still find them under the historical import surface.
export {
  // Auth
  withAuth, defaultAuthPolicy,
  type AuthContext, type AuthPolicy,
  // Context
  readAgentContext,
  type AgentContext, type StateStore, type TransactionSender, type TxCounter,
  type Goal, type Task, type JournalEntry,
  // Tx helpers
  submitOrSend, submitAsAgent, submitWithUserWallet, isDryRunSignature,
  // mpl-core helpers
  getAgentPda,
  // Jupiter
  executeSwap, getSwapQuote, getSwapTransaction, simulateAndVerifySwap,
  SOL_MINT, type SwapParams, type SwapResult, type JupiterConfig,
  // Errors + results
  toToolError, type ToolErrorCode,
  ok, info, err,
  type ToolResult, type ToolSuccess, type ToolInfo, type ToolError,
  type ToolResultErrorCode,
  // Constants
  BASE58_ADDRESS_RE, BASE58_SIGNATURE_RE,
} from '@metaplex-foundation/agent-tools';

// Transport-only modules that stay in shared:
export * from './siws.js';
export * from './nonce-store.js';
export * from './allowlist.js';
export * from './wallet-rate-limit.js';
export * from './types/protocol.js';
