import { fetchAsset } from '@metaplex-foundation/mpl-core';
import { publicKey } from '@metaplex-foundation/umi';
import { createUmi } from './umi.js';
import { getConfig } from './config.js';

interface OwnerCacheEntry {
  assetAddress: string | null;
  owner: string | null;
  fetchedAt: number;
}

let ownerCache: OwnerCacheEntry | null = null;

/**
 * In-flight asset-owner lookups, keyed by `agentAssetAddress`. Prevents
 * concurrent callers from each firing `fetchAsset` on a cache miss.
 */
const inflightLookups: Map<string, Promise<string | null>> = new Map();

/**
 * Resolves the owner of the agent.
 *
 * Resolution order:
 *  1. On-chain asset owner (fetched via `fetchAsset`, cached in memory with TTL)
 *  2. `BOOTSTRAP_WALLET` env var (bootstrap fallback, **never cached**)
 *  3. `null` (no owner resolved — do NOT cache, retry on next call)
 *
 * Pre-registration (no asset address yet), we re-read `BOOTSTRAP_WALLET`
 * every call so operators can rotate it at runtime without a process restart.
 * Post-registration, successful entries are cached for `OWNER_CACHE_TTL_MS`
 * so on-chain ownership changes eventually propagate; failures are never
 * cached so transient RPC blips don't lock the agent.
 *
 * Single-flight: concurrent cache-miss lookups share one in-flight promise.
 */
export async function resolveOwner(agentAssetAddress: string | null): Promise<string | null> {
  const config = getConfig();
  const ttl = config.OWNER_CACHE_TTL_MS;

  if (agentAssetAddress === null) {
    return config.BOOTSTRAP_WALLET ?? null;
  }

  if (
    ownerCache &&
    ownerCache.assetAddress === agentAssetAddress &&
    (ttl === 0 || Date.now() - ownerCache.fetchedAt <= ttl)
  ) {
    return ownerCache.owner;
  }

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
