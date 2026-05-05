import { readFileSync, statSync } from 'node:fs';

export interface AllowlistFileOptions {
  path: string;
  envFallback: readonly string[];
  /** Polling interval for hot-reload, in ms. 0 disables polling. */
  pollIntervalMs?: number;
}

interface FileSnapshot {
  mtimeMs: number;
  wallets: string[];
}

/**
 * Loads an allowlist of base58 pubkeys from a JSON file with the shape
 * `{ "wallets": string[] }`, merged with an env-var fallback list.
 *
 * - Hot-reload: optional mtime-polled re-read on a `setInterval` (caller
 *   passes `pollIntervalMs`). The poller is `unref()`'d so it never holds
 *   the process open.
 * - Missing file: falls back to env list silently (ENOENT is expected when
 *   no allowlist file is mounted).
 * - Malformed file: logs a warning and keeps the last good list — the
 *   service should never lose its allowlist due to a transient bad write.
 */
export class AllowlistFile {
  private snapshot: FileSnapshot | null = null;
  private merged: string[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: AllowlistFileOptions) {
    this.reload();
    if (opts.pollIntervalMs && opts.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => this.reload(), opts.pollIntervalMs);
      this.pollTimer.unref?.();
    }
  }

  /** Stop the hot-reload poller. Idempotent. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Force a re-read (test seam + manual reload). */
  reload(): void {
    let fileWallets: string[] = this.snapshot?.wallets ?? [];
    try {
      const stat = statSync(this.opts.path);
      if (!this.snapshot || stat.mtimeMs !== this.snapshot.mtimeMs) {
        const raw = readFileSync(this.opts.path, 'utf8');
        const parsed = JSON.parse(raw) as { wallets?: unknown };
        if (
          !Array.isArray(parsed.wallets) ||
          !parsed.wallets.every((w) => typeof w === 'string')
        ) {
          throw new Error('expected { "wallets": string[] }');
        }
        // Trim each entry to defend against trailing newlines / BOM /
        // copy-paste whitespace; `isAuthorized` does strict equality.
        fileWallets = (parsed.wallets as string[])
          .map((w) => w.trim())
          .filter((w) => w.length > 0);
        this.snapshot = { mtimeMs: stat.mtimeMs, wallets: fileWallets };
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // File missing — fall back to env only.
        this.snapshot = null;
        fileWallets = [];
      } else {
        // Malformed file or transient read error.
        // INVARIANT: do NOT update `this.snapshot` here. Leaving the prior
        // mtime intact forces the next poll to re-attempt the read once
        // the writer finishes (a partial-write race produces a fresh
        // mtime that won't match snapshot.mtimeMs).
        console.warn(
          `[allowlist] failed to reload ${this.opts.path}: ${err instanceof Error ? err.message : String(err)}; ${this.snapshot ? 'keeping previous list' : 'falling back to env only'}`,
        );
        if (this.snapshot) {
          // Have a known-good prior list — preserve it untouched.
          return;
        }
        // No prior snapshot (e.g. first construction with a malformed file).
        // Fall through to merge envFallback so a typo'd JSON doesn't blank
        // out an otherwise-valid env-supplied allowlist.
        fileWallets = [];
      }
    }
    // Trim env fallback for the same reason as file entries.
    const trimmedEnv = this.opts.envFallback
      .map((w) => w.trim())
      .filter((w) => w.length > 0);
    const merged = new Set<string>([...fileWallets, ...trimmedEnv]);
    // Freeze so callers can't mutate the in-memory allowlist via the
    // `readonly string[]` returned by `current()` (TS readonly is
    // compile-time only — this enforces the invariant at runtime).
    this.merged = Object.freeze([...merged]) as string[];
  }

  current(): readonly string[] {
    return this.merged;
  }
}
