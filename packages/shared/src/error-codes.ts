/**
 * Structured tool-error taxonomy (M16).
 *
 * Every tool's `catch` block maps an unknown error into one of these codes
 * plus a short, LLM-safe message. The raw error is `console.error`'d
 * server-side so operators can debug without leaking internals (RPC URLs,
 * addresses, raw stacks) to the model.
 */
export const ToolErrorCodes = {
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  INVALID_INPUT: 'INVALID_INPUT',
  RPC_FAILURE: 'RPC_FAILURE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
  SLIPPAGE_TOO_HIGH: 'SLIPPAGE_TOO_HIGH',
  PRICE_IMPACT_TOO_HIGH: 'PRICE_IMPACT_TOO_HIGH',
  GENERIC: 'GENERIC',
} as const;

export type ToolErrorCode = typeof ToolErrorCodes[keyof typeof ToolErrorCodes];

export interface ToolErrorShape {
  code: ToolErrorCode;
  message: string;
}

/**
 * Map an unknown caught error to a `{ code, message }` pair that's safe
 * to feed back to the LLM. Classification is best-effort string matching;
 * unclassified errors fall through to `GENERIC` with a capped message.
 */
export function toToolError(err: unknown): ToolErrorShape {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (lower.includes('insufficient') || lower.includes('not enough')) {
    return { code: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds for this operation' };
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return { code: 'TIMEOUT', message: 'Operation timed out' };
  }
  if (lower.includes('not found') || lower.includes('does not exist')) {
    return { code: 'NOT_FOUND', message: 'Resource not found' };
  }
  if (lower.includes('slippage')) {
    return { code: 'SLIPPAGE_TOO_HIGH', message: msg.slice(0, 200) };
  }
  if (lower.includes('price impact')) {
    return { code: 'PRICE_IMPACT_TOO_HIGH', message: msg.slice(0, 200) };
  }
  if (lower.includes('unauthorized') || lower.includes('not the owner')) {
    return { code: 'UNAUTHORIZED', message: 'Unauthorized for this operation' };
  }
  if (lower.includes('rpc') || lower.includes('fetch') || lower.includes('network')) {
    return { code: 'RPC_FAILURE', message: 'RPC or network failure' };
  }
  return { code: 'GENERIC', message: msg.slice(0, 200) };
}
