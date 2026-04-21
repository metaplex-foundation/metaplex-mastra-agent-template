import { fetchAsset } from '@metaplex-foundation/mpl-core';
import { publicKey } from '@metaplex-foundation/umi';
import { createUmi } from './umi.js';
import { getConfig } from './config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthContext {
  connectedWallet: string | null;
  ownerWallet: string | null;
}

/**
 * An authorization policy evaluates whether a tool with a given auth level
 * is allowed to execute in the current context. Developers can replace or
 * extend the default policy to add custom auth levels.
 */
export type AuthPolicy = (authLevel: string, context: AuthContext) => boolean;

// ---------------------------------------------------------------------------
// Default Policy
// ---------------------------------------------------------------------------

/**
 * Ships with two levels:
 *  - `public`  — any connected client can trigger the tool
 *  - `owner`   — only the verified asset owner can trigger the tool
 *
 * Unknown levels are denied by default (fail-closed).
 */
export const defaultAuthPolicy: AuthPolicy = (level, ctx) => {
  if (level === 'public') return true;
  if (level === 'owner') {
    return ctx.ownerWallet !== null && ctx.connectedWallet === ctx.ownerWallet;
  }
  return false;
};

// ---------------------------------------------------------------------------
// Tool Auth Wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps a tool's `execute` function with an authorization check.
 * If the policy denies the call, the tool throws an error that Mastra
 * surfaces to the LLM as a failed tool result — the LLM never executes
 * the underlying logic.
 *
 * Mutates the tool in place and returns it (rather than shallow-spreading)
 * so Mastra-attached non-enumerable metadata is preserved.
 */
export function withAuth<T extends { execute?: (...args: any[]) => any }>(
  tool: T,
  authLevel: string,
  policy: AuthPolicy = defaultAuthPolicy,
): T {
  const originalExecute = tool.execute;
  if (!originalExecute) return tool;

  const wrappedExecute = async (args: any, ctx: any) => {
    const requestContext = ctx?.requestContext;
    const connectedWallet: string | null = requestContext?.get?.('walletAddress') ?? null;
    const ownerWallet: string | null = requestContext?.get?.('ownerWallet') ?? null;

    if (!policy(authLevel, { connectedWallet, ownerWallet })) {
      throw new Error(
        'This operation requires owner authorization. ' +
        `Connected wallet: ${connectedWallet ?? 'none'}. ` +
        'Please connect the owner wallet to use this tool.',
      );
    }

    return originalExecute(args, ctx);
  };

  tool.execute = wrappedExecute as T['execute'];
  return tool;
}

// ---------------------------------------------------------------------------
// Owner Resolution
// ---------------------------------------------------------------------------

interface OwnerCacheEntry {
  assetAddress: string | null;
  owner: string | null;
  fetchedAt: number;
}

let ownerCache: OwnerCacheEntry | null = null;

/**
 * In-flight asset-owner lookups, keyed by `agentAssetAddress`. Prevents
 * concurrent callers from each firing `fetchAsset` on a cache miss (H4).
 * Entries are removed in a `finally` block regardless of success/failure.
 */
const inflightLookups: Map<string, Promise<string | null>> = new Map();

/**
 * Resolves the owner of the agent.
 *
 * Resolution order:
 *  1. On-chain asset owner (fetched via `fetchAsset`, cached in memory with TTL)
 *  2. `BOOTSTRAP_WALLET` env var (bootstrap fallback, **never cached** — see H3)
 *  3. `null` (no owner resolved — do NOT cache, retry on next call)
 *
 * The cache is keyed by `agentAssetAddress` and automatically invalidates
 * when the address changes (e.g. after first registration). Successful
 * entries also expire after `OWNER_CACHE_TTL_MS` so on-chain ownership
 * changes eventually propagate. Failures (RPC/network errors, unknown
 * assets) are NEVER cached, so transient RPC blips don't lock the agent.
 *
 * H3 fix: when `agentAssetAddress === null` we do NOT cache the env-var
 * fallback — operators can rotate `BOOTSTRAP_WALLET` at runtime and the
 * change is picked up immediately without waiting for TTL expiry or
 * process restart.
 *
 * H4 fix: concurrent cache-miss lookups share a single in-flight promise
 * so `fetchAsset` is called at most once per missing cache entry.
 */
export async function resolveOwner(agentAssetAddress: string | null): Promise<string | null> {
  const config = getConfig();
  const ttl = config.OWNER_CACHE_TTL_MS;

  // Pre-registration: always re-read env var, never cache (H3).
  if (agentAssetAddress === null) {
    return config.BOOTSTRAP_WALLET ?? null;
  }

  // Post-registration: consult cache first.
  if (
    ownerCache &&
    ownerCache.assetAddress === agentAssetAddress &&
    (ttl === 0 || Date.now() - ownerCache.fetchedAt <= ttl)
  ) {
    return ownerCache.owner;
  }

  // Single-flight: if a lookup is already in progress for this address,
  // piggy-back on it instead of issuing a duplicate RPC call (H4).
  const existing = inflightLookups.get(agentAssetAddress);
  if (existing) {
    return existing;
  }

  const lookup = (async () => {
    try {
      const umi = createUmi();
      const asset = await fetchAsset(umi, publicKey(agentAssetAddress));
      const owner = asset.owner.toString();
      ownerCache = {
        assetAddress: agentAssetAddress,
        owner,
        fetchedAt: Date.now(),
      };
      return owner;
    } catch (error) {
      console.error(
        'Failed to fetch asset owner:',
        error instanceof Error ? error.message : String(error),
      );
      // Do not write to cache — allow retry on next call.
      return null;
    }
  })();

  inflightLookups.set(agentAssetAddress, lookup);
  try {
    return await lookup;
  } finally {
    inflightLookups.delete(agentAssetAddress);
  }
}

/**
 * Clear the cached owner. Called when the agent asset address changes
 * (e.g. after registration) to force a fresh lookup.
 */
export function clearOwnerCache(): void {
  ownerCache = null;
}
