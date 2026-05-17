export const ZERO_KEYPAIR = '[' + Array.from({ length: 64 }, () => 0).join(',') + ']';

/**
 * NOT REENTRANT. `isolateEnv` writes to a single module-scoped `SAVED_ENV`
 * snapshot; calling it twice without an intervening `restoreEnv` overwrites
 * the original snapshot and the first env is lost forever. Tests MUST pair
 * each `isolateEnv` with a `restoreEnv` (typically in `afterEach`) — do not
 * nest or run concurrently. If reentrant snapshots are ever needed, switch
 * this to a stack of saved envs.
 */
const SAVED_ENV: Record<string, string | undefined> = {};

export function isolateEnv(overrides: Record<string, string> = {}): void {
  for (const k of Object.keys(process.env)) SAVED_ENV[k] = process.env[k];
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, overrides);
}

export function restoreEnv(): void {
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v !== undefined) process.env[k] = v;
  }
}

export function defaultTestEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    SOLANA_RPC_URL: 'http://127.0.0.1:9999',
    ANTHROPIC_API_KEY: 'test-key',
    ...extra,
  };
}
