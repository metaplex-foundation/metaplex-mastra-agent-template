export interface WalletRateLimiterOptions {
  /** Max events allowed in any rolling window of `windowMs`. */
  max: number;
  /** Sliding-window length, in ms. */
  windowMs: number;
  /** Hard cap on tracked keys; oldest entry (LRU) is evicted past this. */
  maxKeys: number;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
  /**
   * Pubkey that is unconditionally allowed and never counts against any
   * budget. Owner-exempt is initialized to null in WS server bootstrap and
   * updated post-startup via `setOwnerExempt` once `resolveOwner` resolves
   * (the constructor is sync, but owner resolution is async).
   */
  ownerExempt?: string | null;
}

interface Entry {
  /** Timestamps of allowed events within the current window. */
  timestamps: number[];
  /** Most recent activity timestamp — used for LRU touch ordering. */
  lastTouchedMs: number;
}

/**
 * Per-wallet sliding-window rate limiter.
 *
 * Aggregates across a wallet's concurrent WebSocket sessions: a single wallet
 * opening N parallel sessions still shares one quota. Bounded memory via an
 * LRU eviction policy keyed off Map insertion order — touching an entry on
 * every `allow()` call (delete + re-insert) keeps the most-recently-used at
 * the tail, so the oldest at the head is evicted first when capacity is hit.
 *
 * Per-process only — multi-replica deployments would need a Redis-backed
 * limiter; that's out of scope here.
 */
export class WalletRateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private ownerExempt: string | null;

  constructor(private readonly opts: WalletRateLimiterOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.ownerExempt = opts.ownerExempt ?? null;
  }

  /**
   * Update the owner-exemption pubkey at runtime. Used by the WS server,
   * which constructs the limiter synchronously (with `null`) before the
   * async on-chain owner resolution completes in `start()`.
   *
   * If the on-chain owner rotates mid-runtime, the cached value here goes
   * stale until the next refresh; that's accepted for v1.
   */
  setOwnerExempt(pk: string | null): void {
    this.ownerExempt = pk;
  }

  /**
   * Returns true and records an event when the wallet is under its budget.
   * Returns false (without recording) when over budget. Owner-exempt wallets
   * always return true and never accrue timestamps.
   */
  allow(pubkey: string): boolean {
    if (this.ownerExempt && pubkey === this.ownerExempt) return true;

    const now = this.now();
    let entry = this.entries.get(pubkey);
    if (entry) {
      // Slide the window: drop timestamps older than windowMs.
      entry.timestamps = entry.timestamps.filter((t) => now - t < this.opts.windowMs);
      // Touch on activity: re-insert so this key becomes the most-recently-used
      // (Map iteration order = insertion order).
      this.entries.delete(pubkey);
      entry.lastTouchedMs = now;
      this.entries.set(pubkey, entry);
    } else {
      // Evict the oldest entry when at capacity. Map iteration order is
      // insertion order, so the first key is the LRU.
      if (this.entries.size >= this.opts.maxKeys) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey !== undefined) this.entries.delete(oldestKey);
      }
      entry = { timestamps: [], lastTouchedMs: now };
      this.entries.set(pubkey, entry);
    }

    if (entry.timestamps.length >= this.opts.max) return false;
    entry.timestamps.push(now);
    return true;
  }

  /** Test seam — total tracked pubkeys. */
  size(): number {
    return this.entries.size;
  }
}
