import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { z } from 'zod';
import bs58 from 'bs58';
import { getState } from './state.js';
import { AllowlistFile } from './allowlist-file.js';
import { loadAgentConfigFile, applyAgentConfigToEnv } from './agent-config.js';

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

// Optional `agent.config.yaml` overlay — provides human-readable defaults
// for non-secret behavioral knobs (persona, worker cadence, slippage caps,
// agent name). Layered UNDER process.env so a deploy-time env override
// always wins. Missing file is the common case (the file is optional);
// malformed file throws here at module load with an actionable message.
try {
  const agentCfg = loadAgentConfigFile();
  if (agentCfg) {
    const written = applyAgentConfigToEnv(agentCfg);
    const keys = Object.keys(written);
    if (keys.length > 0) {
      // Single-line summary so operators see at a glance which fields the
      // yaml supplied vs which were already present in the env.
      console.log(`[config] applied agent.config.yaml defaults: ${keys.join(', ')}`);
    }
  }
} catch (err) {
  // Re-throw — unrecoverable. The original error already names the file
  // and line so the operator can fix it without further hints.
  throw err;
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------
// Core:
//   AGENT_MODE, LLM_MODEL, SOLANA_RPC_URL, AGENT_KEYPAIR,
//   WEB_CHANNEL_PORT, ASSISTANT_NAME, JUPITER_API_KEY,
//   AGENT_FEE_SOL, TOKEN_OVERRIDE, BOOTSTRAP_WALLET,
//   AGENT_ASSET_ADDRESS, AGENT_TOKEN_MINT
// WebSocket auth (SIWS):
//   AGENT_AUTH_MODE        — 'owner' | 'allowlist' | 'open' (auto-resolved)
//   WALLET_ALLOWLIST       — comma-separated base58 pubkeys
//   AUTH_NONCE_TTL_MS      — SIWS nonce TTL (default 60000)
//   AUTH_HANDSHAKE_TIMEOUT_MS — handshake hard timeout (default 30000)
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
//   WALLET_RATE_LIMIT_MAX  — per-wallet sliding-window event cap (default 60)
//   WALLET_RATE_LIMIT_WINDOW_MS — per-wallet rate-limit window length (default 60000)
//   WALLET_RATE_LIMIT_MAX_KEYS — LRU cap on tracked wallets (default 10000)
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

/**
 * WALLET_ALLOWLIST — comma-separated base58 pubkeys allowed to connect when
 * `AGENT_AUTH_MODE=allowlist`. Empty / whitespace entries are dropped so a
 * trailing comma or accidentally-blank `WALLET_ALLOWLIST=` is harmless. The
 * resolved value is `string[]`, not `string`, so downstream code can iterate
 * without re-parsing.
 *
 * Note: this schema does NOT base58-validate entries — that's done at use-site
 * (allowlist resolver) so a single typo in the env doesn't bring the server
 * down on boot. Invalid entries simply never match an incoming public key.
 */
const walletAllowlistSchema = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

/**
 * AGENT_AUTH_MODE — explicit override of the auth tier policy. When unset, the
 * mode is auto-resolved from AGENT_MODE + WALLET_ALLOWLIST in `getConfig()`:
 *   - autonomous → 'owner'
 *   - public     → 'allowlist' if WALLET_ALLOWLIST has entries, else 'open'
 */
const authModeSchema = z.enum(['owner', 'allowlist', 'open']).optional();

/**
 * WS_ALLOWED_ORIGINS — comma-separated list of allowed Origin header values.
 * Parsed into a string[] for the verifyClient callback (C2). Empty entries
 * are filtered. Defaults cover the local Next.js dev servers.
 */
const wsAllowedOriginsSchema = z
  .string()
  .default('http://localhost:3001,http://localhost:3000,https://metaplex.chat,https://www.metaplex.chat')
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
  /**
   * Explicit network identifier for the SIWS auth_challenge. Optional —
   * when unset, the network is inferred from SOLANA_RPC_URL via substring
   * match on `devnet`. Set explicitly when using a custom RPC endpoint
   * whose hostname does not contain "devnet" / "mainnet" (e.g. private
   * RPC providers or testnet).
   */
  SOLANA_NETWORK: z.enum(['solana-mainnet', 'solana-devnet']).optional(),
  AGENT_KEYPAIR: agentKeypairSchema,
  WEB_CHANNEL_PORT: z.preprocess(
    // Fall back to PORT (injected by Railway, Render, Fly, Heroku, etc.) when
    // WEB_CHANNEL_PORT isn't explicitly set. Keeps local dev unchanged.
    (v) => (v === undefined || v === '' ? process.env.PORT : v),
    z.coerce.number().default(3002),
  ),
  // --- WebSocket auth (SIWS) ---
  /** Tier policy: 'owner' | 'allowlist' | 'open'. Auto-resolved if unset. */
  AGENT_AUTH_MODE: authModeSchema,
  /** Comma-separated base58 pubkeys allowed in 'allowlist' tier. */
  WALLET_ALLOWLIST: walletAllowlistSchema,
  /**
   * Path to the JSON allowlist file (`{ "wallets": string[] }`). Resolved
   * relative to the server's `process.cwd()` when not absolute. Default
   * matches the workspace-root convention used by `agent-state.json`.
   */
  WALLET_ALLOWLIST_PATH: z.string().min(1).default('wallets.allowlist.json'),
  /** TTL of issued SIWS handshake nonces, in ms. */
  AUTH_NONCE_TTL_MS: z.coerce.number().int().min(5_000).max(600_000).default(60_000),
  /** Hard cap on how long the server waits for a SIWS handshake to complete. */
  AUTH_HANDSHAKE_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(30_000),
  ASSISTANT_NAME: z.string().default('Agent'),
  /**
   * Persona slug — selects a bundled or fork-defined system-prompt body.
   * Defaults to 'default' (the original template behavior). Unknown slugs
   * silently fall back to default; the agent factory logs a warning so a
   * typo'd value is visible in logs without bricking the agent.
   *
   * Bundled personas:
   *   default, token-launch-concierge, wallet-cleanup-bot,
   *   treasury-rebalancer.
   * See packages/core/src/personas/ for definitions.
   */
  AGENT_PERSONA: optional(z.string().min(1)),
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
  /** Per-wallet rate limit: max messages per WALLET_RATE_LIMIT_WINDOW_MS, aggregated across that wallet's concurrent sessions. */
  WALLET_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(60),
  /** Sliding-window length for the per-wallet rate limit, in ms. */
  WALLET_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  /** LRU cap on tracked wallets in the per-wallet rate limiter. */
  WALLET_RATE_LIMIT_MAX_KEYS: z.coerce.number().int().min(100).default(10_000),
  // --- Autonomous-mode worker loop ---
  /** Sleep between ticks, in ms. Tick body runs to completion before sleeping. (autonomous mode only) */
  TICK_INTERVAL_MS: z.coerce.number().int().min(100).default(300000),
  /**
   * When true, transaction-submitting tools log "would have sent X" and
   * return a synthetic signature instead of submitting. Default-on so a
   * fresh fork can never accidentally spend on first boot. Flip to false
   * for production. (autonomous mode only)
   *
   * Safety: anything other than an explicit false-y string keeps dry-run
   * ON. A typo like `AUTONOMOUS_DRY_RUN=ture` must NOT silently disable
   * the safety net — only `false` / `0` (case-insensitive) or boolean
   * `false` flip it off.
   */
  AUTONOMOUS_DRY_RUN: z.preprocess(
    (v) => {
      if (typeof v === 'boolean') return v;
      if (v === undefined) return true;
      const s = String(v).toLowerCase().trim();
      if (s === 'false' || s === '0') return false;
      return true; // unrecognized strings (incl. typos) stay safe
    },
    z.boolean().default(true),
  ),
  /** Per-tick transaction submission cap. Resets every tick. (autonomous mode only) */
  MAX_TICK_TX_COUNT: z.coerce.number().int().min(0).default(3),
  /**
   * Owner-gated /_dashboard auth token. When set, requests must supply it
   * via the `X-Dashboard-Token` header — query-string tokens are NOT
   * accepted (they leak via access logs, Referer, and browser history).
   * When unset, the dashboard is reachable from loopback only (127.0.0.1
   * / ::1) — fail-closed for any non-loopback request. Avoid logging this
   * value; it's effectively a bearer credential.
   */
  DASHBOARD_TOKEN: optional(z.string().min(8)),
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

    // Resolve AGENT_AUTH_MODE if not explicitly set:
    //   autonomous → owner (only the on-chain owner can drive the agent)
    //   public + any allowlist entries (file ∪ env) → allowlist
    //   public + no allowlist → open (any SIWS-verified wallet)
    //
    // The file source is consulted via a one-shot AllowlistFile read (no
    // polling) so an operator who populates wallets.allowlist.json without
    // also setting WALLET_ALLOWLIST still gets the 'allowlist' default.
    if (!_config.AGENT_AUTH_MODE) {
      if (_config.AGENT_MODE === 'autonomous') {
        _config.AGENT_AUTH_MODE = 'owner';
      } else {
        const merged = new AllowlistFile({
          path: _config.WALLET_ALLOWLIST_PATH,
          envFallback: _config.WALLET_ALLOWLIST,
          // pollIntervalMs omitted — one-shot read, no setInterval started.
        }).current();
        _config.AGENT_AUTH_MODE = merged.length > 0 ? 'allowlist' : 'open';
      }
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
