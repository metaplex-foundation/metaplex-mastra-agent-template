import { readFileSync, statSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

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

  /** File path the allowlist is read from / written to (absolute or relative as supplied). */
  get path(): string {
    return this.opts.path;
  }

  /** Wallets supplied via the env-var fallback. Read-only from callers. */
  get envWallets(): readonly string[] {
    return this.opts.envFallback;
  }

  /**
   * Wallets currently in the FILE (not env). Reads cached snapshot — call
   * `reload()` first if a hot-edit needs to be picked up. The split is
   * intentional: only the file portion is mutable from the admin panel.
   * Env-supplied entries can only be changed by editing .env + restart.
   */
  fileWallets(): readonly string[] {
    return this.snapshot?.wallets ?? [];
  }

  /**
   * Add a base58 pubkey to the file. Idempotent — adding an existing
   * entry is a no-op (returns false). Returns true when the file was
   * actually updated. Throws on a write failure (caller surfaces as a
   * targeted protocol error).
   *
   * Caller is responsible for validating that `pubkey` is a well-formed
   * base58 32-byte address. We trim defensively but do not parse.
   */
  addWallet(pubkey: string): boolean {
    const trimmed = pubkey.trim();
    if (trimmed.length === 0) return false;
    const current = this.snapshot?.wallets ?? [];
    if (current.includes(trimmed)) return false;
    const next = [...current, trimmed];
    this.writeFile(next);
    this.reload();
    return true;
  }

  /**
   * Remove a base58 pubkey from the file. Idempotent — removing a missing
   * entry is a no-op (returns false). Returns true when the file was
   * actually updated.
   *
   * NB: a wallet that's also in `envFallback` will continue to be allowed
   * after removal — only the file portion is mutable. The protocol layer
   * tells the operator about that via the `env_only` error code when
   * trying to remove an env-supplied entry, so they don't think the
   * removal failed silently.
   */
  removeWallet(pubkey: string): boolean {
    const trimmed = pubkey.trim();
    const current = this.snapshot?.wallets ?? [];
    if (!current.includes(trimmed)) return false;
    const next = current.filter((w) => w !== trimmed);
    this.writeFile(next);
    this.reload();
    return true;
  }

  /**
   * Atomic write — tmp file + rename, mode 0600. Mirrors agent-state.json's
   * pattern. We don't preserve any extra keys in the JSON (e.g. operator
   * comments) — the file shape is `{ "wallets": string[] }` and that's it.
   *
   * INVARIANT: invalidate `this.snapshot` after writing so the next
   * `reload()` MUST re-read the file from disk. Without this, an
   * add/remove → reload pair within a single filesystem mtime tick (common
   * on Linux ext4 in CI runners) sees a matching mtime and short-circuits
   * the re-read, leaving `current()` stale. The mtime-skip optimization is
   * for external pollers, not for self-induced writes.
   */
  private writeFile(wallets: string[]): void {
    const dir = dirname(this.opts.path);
    // Defensive: refuse to write if the directory doesn't exist. Otherwise
    // the operator could end up with a file in process.cwd() they didn't
    // expect (e.g. on a misconfigured WALLET_ALLOWLIST_PATH).
    if (!existsSync(dir)) {
      throw new Error(`allowlist directory does not exist: ${dir}`);
    }
    const tmpPath = this.opts.path + '.tmp';
    const payload = JSON.stringify({ wallets }, null, 2) + '\n';
    writeFileSync(tmpPath, payload, { mode: 0o600 });
    renameSync(tmpPath, this.opts.path);
    // Force the next reload to re-read regardless of mtime resolution.
    this.snapshot = null;
  }
}
