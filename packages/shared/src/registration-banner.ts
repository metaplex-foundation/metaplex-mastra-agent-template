import { detectPaas, type PaasInfo } from './paas.js';

export interface RegistrationBannerArgs {
  /** Agent identity vs token mint — banner copy differs slightly. */
  kind: 'agent' | 'token';
  /** The newly-minted base58 address. */
  address: string;
  /** Env var the operator should persist. */
  envKey: 'AGENT_ASSET_ADDRESS' | 'AGENT_TOKEN_MINT';
  /** Pre-detected platform info; omit to detect from process.env. */
  paas?: PaasInfo;
}

/**
 * Build a multi-line, attention-grabbing console banner reminding the
 * operator to persist the new on-chain identity / token mint to env. On
 * PaaS targets with ephemeral filesystems (Railway, Fly, Render, Heroku)
 * this is the difference between an agent that survives redeploys and
 * one that silently re-registers itself on every restart.
 *
 * The banner is plain text (no ANSI codes) so it renders cleanly in
 * structured-log aggregators and Railway's web log viewer alike. Color
 * coding is added at print-time by `printRegistrationBanner` based on
 * whether stderr is a TTY.
 */
export function buildRegistrationBanner(args: RegistrationBannerArgs): string {
  const paas = args.paas ?? detectPaas();
  const headline = args.kind === 'agent'
    ? 'Agent identity registered on-chain'
    : 'Agent token launched on-chain';
  const envLine = `${args.envKey}=${args.address}`;
  const persistedTo = args.kind === 'agent'
    ? 'agent-state.json (agentAssetAddress)'
    : 'agent-state.json (agentTokenMint)';

  const lines: string[] = [];
  lines.push('');
  lines.push('================================================================');
  lines.push(`  ⚠  ACTION REQUIRED — ${headline}`);
  lines.push('================================================================');
  lines.push('');
  lines.push(`  Address persisted to ${persistedTo}.`);
  lines.push('  Detected hosting environment: ' + paas.label);
  lines.push('');
  lines.push('  IMPORTANT: this filesystem may be ephemeral on your host. To');
  lines.push('  survive the next redeploy, copy the line below into your env:');
  lines.push('');
  lines.push(`      ${envLine}`);
  lines.push('');
  if (paas.instructions) {
    lines.push('  ' + paas.instructions);
    lines.push('');
  }
  lines.push('================================================================');
  lines.push('');
  return lines.join('\n');
}

/**
 * Build the banner and print it to stderr. Stderr (rather than stdout) so
 * the banner stays visible even when stdout is being piped or parsed.
 *
 * Idempotent within a process — repeated calls with the same envKey are
 * suppressed after the first emission. Most callers (register-agent,
 * launch-token) only fire once per process, but the worker loop or
 * concurrent chat sessions could re-enter; we'd rather print twice than
 * miss the first emission entirely, so the dedupe is conservative.
 */
const _printedKeys = new Set<string>();

export function printRegistrationBanner(args: RegistrationBannerArgs): void {
  const dedupeKey = `${args.envKey}:${args.address}`;
  if (_printedKeys.has(dedupeKey)) return;
  _printedKeys.add(dedupeKey);
  const banner = buildRegistrationBanner(args);
  // Yellow when stderr is a TTY; plain text otherwise (Railway log viewer,
  // Datadog, etc. render ANSI poorly when ingested as JSON).
  const isTty = typeof process.stderr.isTTY === 'boolean' && process.stderr.isTTY;
  if (isTty) {
    // ANSI yellow + bold for visibility, reset at end.
    process.stderr.write('\x1b[33;1m' + banner + '\x1b[0m\n');
  } else {
    process.stderr.write(banner + '\n');
  }
}

/** Test seam — clears the dedupe set. Not exported in production paths. */
export function _resetRegistrationBannerDedupeForTests(): void {
  _printedKeys.clear();
}
