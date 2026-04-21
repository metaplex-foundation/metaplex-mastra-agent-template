import type { AgentContext } from './types/agent.js';

/**
 * Safely read the full `AgentContext` out of a Mastra `RequestContext`
 * (or any Map-like object exposing `.get(key)`). Missing keys fall back
 * to sensible defaults so callers never need to deal with `undefined`.
 *
 * Replaces inline per-field composition scattered across tools (M8).
 */
export function readAgentContext(ctx: any): AgentContext {
  const get = <T>(key: string, fallback: T): T => {
    try {
      const value = ctx?.get?.(key);
      return value === undefined || value === null ? fallback : (value as T);
    } catch {
      return fallback;
    }
  };

  // agentMode has no safe default: it's always populated by the server from
  // validated config, and a silent fallback would hide wiring bugs in custom
  // runtimes (e.g. autonomous worker loops that forget to set it).
  const agentMode = ctx?.get?.('agentMode');
  if (agentMode !== 'public' && agentMode !== 'autonomous') {
    throw new Error(
      "AgentContext is missing 'agentMode'. Construct the RequestContext with ['agentMode', 'public'] or ['agentMode', 'autonomous'] before invoking tools.",
    );
  }

  return {
    walletAddress: get<string | null>('walletAddress', null),
    transactionSender: get<AgentContext['transactionSender']>('transactionSender', null),
    agentMode,
    agentAssetAddress: get<string | null>('agentAssetAddress', null),
    agentTokenMint: get<string | null>('agentTokenMint', null),
    agentFeeSol: get<number>('agentFeeSol', 0.001),
    tokenOverride: get<string | null>('tokenOverride', null),
    ownerWallet: get<string | null>('ownerWallet', null),
  };
}
