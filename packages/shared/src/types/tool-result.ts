/**
 * Standardized tool result shape (H1).
 *
 * Every tool returns one of three shapes:
 *   - `{ status: 'success', ...data }` for normal success.
 *   - `{ status: 'info', ...data }`    for non-error informational outcomes
 *                                      (e.g. "already registered", "no-op").
 *   - `{ status: 'error', code, message }` for failures.
 *
 * Use the `ok()`, `info()`, and `err()` helpers to construct these so every
 * tool's return paths are consistent — the LLM can reliably branch on
 * `result.status === 'success'` without worrying about missing fields.
 */

export type ToolErrorCode =
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_INPUT'
  | 'RPC_FAILURE'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'INTEGRITY'
  | 'SLIPPAGE_TOO_HIGH'
  | 'PRICE_IMPACT_TOO_HIGH'
  | 'NOT_REGISTERED'
  | 'NO_TOKEN'
  | 'GENERIC';

export type ToolSuccess<T> = { status: 'success' } & T;
export type ToolInfo<T> = { status: 'info' } & T;
export type ToolError = { status: 'error'; code: ToolErrorCode; message: string };
export type ToolResult<T = Record<string, unknown>> =
  | ToolSuccess<T>
  | ToolInfo<T>
  | ToolError;

export const ok = <T extends object>(data: T): ToolSuccess<T> => ({
  status: 'success',
  ...data,
});

export const info = <T extends object>(data: T): ToolInfo<T> => ({
  status: 'info',
  ...data,
});

export const err = (code: ToolErrorCode, message: string): ToolError => ({
  status: 'error',
  code,
  message,
});
