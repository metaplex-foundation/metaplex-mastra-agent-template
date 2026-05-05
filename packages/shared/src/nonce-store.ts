import { randomBytes } from 'crypto';

export interface IssuedNonce {
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export type ConsumeResult =
  | { ok: true }
  | { ok: false; reason: 'nonce_invalid' | 'nonce_expired' };

interface Entry {
  expiresAtMs: number;
}

export interface NonceStoreOptions {
  ttlMs: number;
  /** Returns ms since epoch. Defaults to `Date.now`. Test seam. */
  now?: () => number;
}

/**
 * Single-use, TTL-bounded nonce store for SIWS challenge handshakes.
 *
 * Memory is unbounded: callers MUST invoke `sweep()` periodically to evict
 * expired entries (and SHOULD enforce a max-size cap at the call site to
 * defend against handshake-flood). The store itself does neither.
 */
export class NonceStore {
  private readonly entries = new Map<string, Entry>();
  private now: () => number;

  constructor(private readonly opts: NonceStoreOptions) {
    if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
      throw new Error(`NonceStore: ttlMs must be a positive finite number (got ${opts.ttlMs})`);
    }
    this.now = opts.now ?? (() => Date.now());
  }

  /** Test seam — production callers never use this. */
  setNow(fn: () => number): void {
    this.now = fn;
  }

  issue(): IssuedNonce {
    const nonce = randomBytes(16).toString('hex');
    const issuedMs = this.now();
    const expiresMs = issuedMs + this.opts.ttlMs;
    this.entries.set(nonce, { expiresAtMs: expiresMs });
    return {
      nonce,
      issuedAt: new Date(issuedMs).toISOString(),
      expiresAt: new Date(expiresMs).toISOString(),
    };
  }

  consume(nonce: string): ConsumeResult {
    const entry = this.entries.get(nonce);
    if (!entry) return { ok: false, reason: 'nonce_invalid' };
    this.entries.delete(nonce); // single-use, even on expiry
    if (this.now() > entry.expiresAtMs) {
      return { ok: false, reason: 'nonce_expired' };
    }
    return { ok: true };
  }

  /** Periodic sweep to bound memory under SIWS-flood. */
  sweep(): void {
    // Map iteration is well-defined under in-place deletion: deleting the
    // current key during iteration is safe per ECMAScript, and entries
    // added after iteration starts may or may not be visited (they won't
    // be expired yet anyway).
    const now = this.now();
    for (const [k, v] of this.entries) {
      if (now > v.expiresAtMs) this.entries.delete(k);
    }
  }

  /** Test/inspection seam — total tracked nonces (live + expired-but-not-swept). */
  size(): number {
    return this.entries.size;
  }
}
