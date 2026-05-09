import type { Persona } from './types.js';
import { defaultPersona } from './default.js';
import { tokenLaunchConcierge } from './token-launch-concierge.js';
import { walletCleanupBot } from './wallet-cleanup-bot.js';
import { treasuryRebalancer } from './treasury-rebalancer.js';

export type { Persona } from './types.js';

/**
 * Registry of bundled personas. Forks add their own by importing here and
 * spreading into the registry — no other code paths need updating.
 *
 * The map is exported as `Record<string, Persona>` rather than a typed
 * `keyof` constant so user-defined personas work without TS gymnastics.
 *
 * Each bundled persona's body is matched against the toolset the agent
 * actually ships with — we deliberately do NOT bundle personas that
 * promise read-only behavior or NFT-specific tools, because the current
 * tool registry has no enforcement layer to back those claims (e.g. the
 * LLM could still call swap-token from a persona that claims to be
 * read-only). Such personas wait on the per-persona tool-filter feature
 * tracked alongside #4 in the UX audit.
 */
export const personas: Record<string, Persona> = {
  default: defaultPersona,
  'token-launch-concierge': tokenLaunchConcierge,
  'wallet-cleanup-bot': walletCleanupBot,
  'treasury-rebalancer': treasuryRebalancer,
};

/**
 * Resolve a persona by slug. Falls back to `default` for unknown / empty
 * names so a typo'd AGENT_PERSONA doesn't brick the agent. The fallback
 * is logged once at startup (see `getPersona` consumers).
 */
export function getPersona(name?: string | null): Persona {
  if (!name) return defaultPersona;
  return personas[name] ?? defaultPersona;
}

/**
 * Slugs of all bundled personas, in display order. Used by `pnpm bootstrap`
 * to render the picker.
 */
export const personaNames: ReadonlyArray<string> = Object.keys(personas);

export {
  defaultPersona,
  tokenLaunchConcierge,
  walletCleanupBot,
  treasuryRebalancer,
};
