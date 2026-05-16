export const ZERO_KEYPAIR = '[' + Array.from({ length: 64 }, () => 0).join(',') + ']';

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
