import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Optional `agent.config.yaml` overlay. Layered UNDER environment variables —
 * env always wins. Provides a human-readable place to commit non-secret
 * behavioral knobs (persona, worker cadence, dry-run, slippage caps, agent
 * name) without sprawling env files.
 *
 * Secrets (AGENT_KEYPAIR, ANTHROPIC_API_KEY, etc.) intentionally stay out
 * of this file — never commit them under any circumstances.
 *
 * Layering rule:
 *   process.env value present (non-empty) → win
 *   else agent.config.yaml value          → fill into process.env
 *   else zod default                      → applied at validation time
 *
 * Empty-string env values (a common dotenv artifact for `KEY=` lines) are
 * treated as unset so a yaml default can fill them — otherwise yaml would
 * be useless in practice for any field also listed in .env.example.
 */

const WORKER_SCHEMA = z
  .object({
    interval_ms: z.number().int().min(100).optional(),
    dry_run: z.boolean().optional(),
    max_tx_per_tick: z.number().int().min(0).optional(),
  })
  .strict();

const LIMITS_SCHEMA = z
  .object({
    max_slippage_bps: z.number().int().min(1).max(10000).optional(),
    max_price_impact_pct: z.number().min(0).max(100).optional(),
  })
  .strict();

const AGENT_CONFIG_SCHEMA = z
  .object({
    agent_name: z.string().min(1).optional(),
    persona: z.string().min(1).optional(),
    worker: WORKER_SCHEMA.optional(),
    limits: LIMITS_SCHEMA.optional(),
  })
  .strict();

export type AgentConfigFile = z.infer<typeof AGENT_CONFIG_SCHEMA>;

const DEFAULT_FILENAME = 'agent.config.yaml';
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/**
 * Walk up from `from` looking for the workspace root (pnpm-workspace.yaml).
 * Returns the path where `agent.config.yaml` would live if it exists. Same
 * convention as agent-state.json — keeps both files alongside the workspace
 * marker so monorepo and standalone setups behave the same.
 */
function findConfigPath(from: string): string {
  let dir = from;
  while (true) {
    if (existsSync(resolve(dir, WORKSPACE_MARKER))) {
      return resolve(dir, DEFAULT_FILENAME);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(from, DEFAULT_FILENAME);
}

/**
 * Read and validate `agent.config.yaml`. Returns null when the file is
 * missing (the common case — it's optional). Throws with a friendly,
 * file-aware error message when the file exists but is malformed; the
 * caller (config.ts) lets that bubble to the operator at startup.
 */
export function loadAgentConfigFile(path?: string): AgentConfigFile | null {
  const resolved = path ?? findConfigPath(process.cwd());
  if (!existsSync(resolved)) return null;
  const raw = readFileSync(resolved, 'utf8');
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid agent.config.yaml at ${resolved}: ${detail}`);
  }
  if (parsed === null || parsed === undefined) {
    // Empty file is treated the same as missing — equivalent to "use defaults".
    return null;
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Invalid agent.config.yaml at ${resolved}: expected a mapping at the top level, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
    );
  }
  const result = AGENT_CONFIG_SCHEMA.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid agent.config.yaml at ${resolved}:\n${errors}`);
  }
  return result.data;
}

/**
 * Translate a parsed agent.config.yaml into a sparse `{envKey: stringValue}`
 * dictionary. Pure — does not touch process.env. Useful for tests and for
 * the `applyAgentConfigToEnv` consumer which decides which keys to commit.
 *
 * Only fields present in the config produce env entries; absent fields are
 * skipped entirely (vs emitting empty strings, which would clobber env
 * defaults later).
 */
export function agentConfigToEnvDefaults(
  cfg: AgentConfigFile,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (cfg.agent_name !== undefined) out.ASSISTANT_NAME = cfg.agent_name;
  if (cfg.persona !== undefined) out.AGENT_PERSONA = cfg.persona;
  if (cfg.worker?.interval_ms !== undefined) {
    out.TICK_INTERVAL_MS = String(cfg.worker.interval_ms);
  }
  if (cfg.worker?.dry_run !== undefined) {
    out.AUTONOMOUS_DRY_RUN = cfg.worker.dry_run ? 'true' : 'false';
  }
  if (cfg.worker?.max_tx_per_tick !== undefined) {
    out.MAX_TICK_TX_COUNT = String(cfg.worker.max_tx_per_tick);
  }
  if (cfg.limits?.max_slippage_bps !== undefined) {
    out.MAX_SLIPPAGE_BPS = String(cfg.limits.max_slippage_bps);
  }
  if (cfg.limits?.max_price_impact_pct !== undefined) {
    out.MAX_PRICE_IMPACT_PCT = String(cfg.limits.max_price_impact_pct);
  }
  return out;
}

/**
 * Layer yaml defaults INTO the supplied env-shaped object (defaulting to
 * process.env). Only fills slots that are unset OR set to an empty string —
 * env always wins when the value is non-empty. The empty-string behavior
 * is deliberate: dotenv emits empty values for `KEY=` lines, and operators
 * expect a yaml default to win over those.
 *
 * Returns a sparse dictionary of the keys that were actually written, so
 * callers can log a one-line summary at startup.
 */
export function applyAgentConfigToEnv(
  cfg: AgentConfigFile,
  target: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> {
  const defaults = agentConfigToEnvDefaults(cfg);
  const written: Record<string, string> = {};
  for (const [key, value] of Object.entries(defaults)) {
    const existing = target[key];
    if (existing === undefined || existing === '') {
      target[key] = value;
      written[key] = value;
    }
  }
  return written;
}
