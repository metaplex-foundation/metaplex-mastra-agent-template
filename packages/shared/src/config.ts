import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { z } from 'zod';
import bs58 from 'bs58';
import { getState } from './state.js';

// Load .env from workspace root — walk up from cwd until we find it
function findEnvFile(from: string): string {
  let dir = from;
  while (true) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return resolve(from, '.env'); // fallback
}

config({ path: findEnvFile(process.cwd()) });

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------
// Core:
//   AGENT_MODE, LLM_MODEL, SOLANA_RPC_URL, AGENT_KEYPAIR,
//   WEB_CHANNEL_PORT, WEB_CHANNEL_TOKEN, ASSISTANT_NAME, JUPITER_API_KEY,
//   AGENT_FEE_SOL, TOKEN_OVERRIDE, BOOTSTRAP_WALLET,
//   AGENT_ASSET_ADDRESS, AGENT_TOKEN_MINT
// Tuning:
//   MAX_STEPS, ENABLE_DEBUG_EVENTS, MAX_CONNECTIONS
// Security hardening:
//   MAX_SLIPPAGE_BPS       — cap for Jupiter swap slippage (default 500 bps = 5%)
//   MAX_PRICE_IMPACT_PCT   — cap for Jupiter quote priceImpactPct (default 2.0 %)
//   OWNER_CACHE_TTL_MS     — TTL for successful owner lookups (default 300000 = 5 min)
//   WS_ALLOWED_ORIGINS     — comma-separated WS Origin allowlist (C2)
//   MAX_MESSAGE_CONTENT    — per-message content byte cap (M3, default 8000)
//   MAX_RPC_TIME_BUDGET_MS — per-turn wall-clock budget (M5, default 60000)
//   LOG_AUTH_FAILURES      — log token/origin/owner/rate-limit denials (L6, default true)
// LLM API keys (at least one must match the LLM_MODEL provider prefix):
//   ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY
// ---------------------------------------------------------------------------

/** Solana base58 address (32-44 chars, no 0/O/I/l). */
export const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Solana base58 signature (64-88 chars). */
export const BASE58_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/**
 * base58 address schema — validates regex AND decodes via bs58, asserting the
 * decoded length is exactly 32 bytes (M6). The regex alone permits strings
 * that decode to the wrong length (e.g. 31 or 33 bytes) which would silently
 * fail deeper in the stack; this catches them at config load.
 */
const base58Address = (fieldName: string) =>
  z
    .string()
    .regex(BASE58_ADDRESS_RE, `${fieldName} must be a valid base58 Solana address`)
    .refine((val) => {
      try {
        return bs58.decode(val).length === 32;
      } catch {
        return false;
      }
    }, `${fieldName} must decode to a 32-byte Solana public key`);

/**
 * Wraps an optional schema so that empty strings coming from dotenv (e.g. a
 * `FOO=` line left empty in .env) are treated as missing. Without this, zod's
 * `.optional()` accepts `""` as present and the inner refinements fail — which
 * breaks every fresh fork of this template where users copy .env.example
 * verbatim and leave the optional fields empty.
 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

/**
 * AGENT_KEYPAIR must be either:
 *   - a 64-byte base58-encoded secret key, OR
 *   - a JSON array of 64 numbers (0-255), matching @solana/web3.js keypair.json format.
 */
const agentKeypairSchema = z
  .string()
  .min(1, 'AGENT_KEYPAIR is required')
  .refine((val) => {
    // Try JSON byte-array format first
    const trimmed = val.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (
          Array.isArray(parsed) &&
          parsed.length === 64 &&
          parsed.every((n) => typeof n === 'number' && n >= 0 && n <= 255 && Number.isInteger(n))
        ) {
          return true;
        }
      } catch {
        return false;
      }
      return false;
    }
    // Otherwise try base58 decode
    try {
      const decoded = bs58.decode(trimmed);
      return decoded.length === 64;
    } catch {
      return false;
    }
  }, 'AGENT_KEYPAIR must be a 64-byte base58 secret key or JSON byte array');

let _weakTokenWarned = false;

const webChannelTokenSchema = z
  .string()
  .min(32, 'WEB_CHANNEL_TOKEN must be at least 32 characters; use `openssl rand -hex 24` to generate a strong token');

/**
 * WS_ALLOWED_ORIGINS — comma-separated list of allowed Origin header values.
 * Parsed into a string[] for the verifyClient callback (C2). Empty entries
 * are filtered. Defaults cover the local Next.js dev servers.
 */
const wsAllowedOriginsSchema = z
  .string()
  .default('http://localhost:3001,http://localhost:3000')
  .transform((raw) =>
    raw
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
  );

const envSchema = z.object({
  AGENT_MODE: z.enum(['public', 'autonomous']).default('public'),
  LLM_MODEL: z.string().default('anthropic/claude-sonnet-4-5-20250929'),
  SOLANA_RPC_URL: z.string().default('https://api.devnet.solana.com'),
  AGENT_KEYPAIR: agentKeypairSchema,
  WEB_CHANNEL_PORT: z.preprocess(
    // Fall back to PORT (injected by Railway, Render, Fly, Heroku, etc.) when
    // WEB_CHANNEL_PORT isn't explicitly set. Keeps local dev unchanged.
    (v) => (v === undefined || v === '' ? process.env.PORT : v),
    z.coerce.number().default(3002),
  ),
  WEB_CHANNEL_TOKEN: webChannelTokenSchema,
  ASSISTANT_NAME: z.string().default('Agent'),
  JUPITER_API_KEY: optional(z.string().min(1)),
  AGENT_FEE_SOL: z.coerce.number().min(0).max(1).default(0.001),
  TOKEN_OVERRIDE: optional(base58Address('TOKEN_OVERRIDE')),
  BOOTSTRAP_WALLET: optional(base58Address('BOOTSTRAP_WALLET')),
  AGENT_ASSET_ADDRESS: optional(base58Address('AGENT_ASSET_ADDRESS')),
  AGENT_TOKEN_MINT: optional(base58Address('AGENT_TOKEN_MINT')),
  MAX_STEPS: z.coerce.number().min(1).max(50).default(10),
  ENABLE_DEBUG_EVENTS: z.preprocess(
    (v) => v === undefined ? true : v === 'true' || v === '1',
    z.boolean().default(true),
  ),
  MAX_CONNECTIONS: z.coerce.number().min(1).max(1000).default(10),
  MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(10000).default(500),
  MAX_PRICE_IMPACT_PCT: z.coerce.number().min(0).max(100).default(2.0),
  OWNER_CACHE_TTL_MS: z.coerce.number().int().min(0).default(300000),
  // --- v2 remediation: server hardening env vars ---
  /** Comma-separated list of allowed WebSocket Origin header values (C2). */
  WS_ALLOWED_ORIGINS: wsAllowedOriginsSchema,
  /** Max bytes allowed per chat message.content (M3). */
  MAX_MESSAGE_CONTENT: z.coerce.number().int().min(1).default(8000),
  /** Cumulative wall-clock budget per agent.stream() call in ms (M5). */
  MAX_RPC_TIME_BUDGET_MS: z.coerce.number().int().min(1).default(60000),
  /** If true, emit warn-level logs for auth failures (L6). */
  LOG_AUTH_FAILURES: z.preprocess(
    (v) => v === undefined ? true : v === 'true' || v === '1',
    z.boolean().default(true),
  ),
});

export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Map an LLM_MODEL provider prefix (`provider/model`) to the env var
 * that must be set for that provider to authenticate successfully.
 */
const LLM_PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

function validateLlmApiKey(cfg: EnvConfig): void {
  const [provider] = cfg.LLM_MODEL.split('/');
  if (!provider) return; // no provider prefix — let Mastra decide
  const expected = LLM_PROVIDER_ENV_KEYS[provider.toLowerCase()];
  if (!expected) return; // unknown/custom provider — skip check
  const value = process.env[expected];
  if (!value || value.length === 0) {
    throw new Error(
      `Missing LLM API key: LLM_MODEL="${cfg.LLM_MODEL}" requires ${expected} ` +
      'to be set in the environment. See .env.example.'
    );
  }
}

let _config: EnvConfig | null = null;

export function getConfig(): EnvConfig {
  if (!_config) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      const errors = result.error.issues.map(
        (i) => `  ${i.path.join('.')}: ${i.message}`
      );
      throw new Error(
        `Invalid environment configuration:\n${errors.join('\n')}\n\nSee .env.example for required variables.`
      );
    }
    _config = result.data;

    // LLM provider key presence check
    validateLlmApiKey(_config);

    // Soft warning for weak but valid-length tokens
    if (!_weakTokenWarned && _config.WEB_CHANNEL_TOKEN.length < 32) {
      console.warn(
        'WEB_CHANNEL_TOKEN is weak (< 32 chars); use `openssl rand -hex 24` for production',
      );
      _weakTokenWarned = true;
    }

    const state = getState();
    if (!_config.AGENT_ASSET_ADDRESS && state.agentAssetAddress && BASE58_ADDRESS_RE.test(state.agentAssetAddress)) {
      _config.AGENT_ASSET_ADDRESS = state.agentAssetAddress;
    }
    if (!_config.AGENT_TOKEN_MINT && state.agentTokenMint && BASE58_ADDRESS_RE.test(state.agentTokenMint)) {
      _config.AGENT_TOKEN_MINT = state.agentTokenMint;
    }

    // Autonomous mode pre-registration gate: without a resolved on-chain owner
    // AND without a BOOTSTRAP_WALLET, nobody can connect to trigger the initial
    // registration — the agent would be silently bricked. Fail fast with a
    // clear error instead.
    if (
      _config.AGENT_MODE === 'autonomous' &&
      !_config.AGENT_ASSET_ADDRESS &&
      !_config.BOOTSTRAP_WALLET
    ) {
      throw new Error(
        'BOOTSTRAP_WALLET is required in autonomous mode before the agent is ' +
        'registered on-chain.\n' +
        'Set it to the base58 pubkey of the wallet allowed to bootstrap the ' +
        'agent and trigger initial registration.\n' +
        'After registration (AGENT_ASSET_ADDRESS set), the on-chain asset ' +
        'owner takes precedence and BOOTSTRAP_WALLET is no longer consulted.',
      );
    }
  }
  return _config;
}

/**
 * Update the in-memory config cache after state changes.
 * Call this after setState() when the config needs to reflect new values
 * within the same process (e.g. after registration saves a new asset address).
 */
export function updateConfigFromState(): void {
  if (!_config) return;
  const state = getState();
  if (state.agentAssetAddress && BASE58_ADDRESS_RE.test(state.agentAssetAddress)) {
    _config.AGENT_ASSET_ADDRESS = state.agentAssetAddress;
  }
  if (state.agentTokenMint && BASE58_ADDRESS_RE.test(state.agentTokenMint)) {
    _config.AGENT_TOKEN_MINT = state.agentTokenMint;
  }
}

export type AgentMode = 'public' | 'autonomous';
