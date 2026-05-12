import type { IncomingMessage, ServerResponse } from 'http';
import { getConfig, getState } from '@metaplex-foundation/shared';

/**
 * `/_dashboard` — owner-gated worker-loop snapshot.
 *
 * Two outputs:
 *   GET /_dashboard       → HTML rendering for humans
 *   GET /_dashboard.json  → JSON for tooling / uptime probes
 *
 * Auth model:
 *   - DASHBOARD_TOKEN unset (default): loopback-only (127.0.0.1 / ::1).
 *     Adequate for `pnpm dev`, never exposed publicly.
 *   - DASHBOARD_TOKEN set: any request supplying the token via the
 *     `X-Dashboard-Token: <value>` header is allowed. Loopback origin is
 *     also still allowed (so `pnpm dev` keeps working without setting the
 *     env). Query-string tokens are intentionally NOT accepted — they
 *     leak via access logs, Referer headers, and browser history.
 *
 * Why not SIWS-gate it? SIWS lives over WebSocket and is per-session.
 * The dashboard is HTTP and meant to be poll-friendly (uptime monitors,
 * Grafana scraping, curl). A bearer token matches that surface. Operators
 * who want stronger auth should put it behind a reverse proxy — that's a
 * standard pattern and out of scope for the v0 endpoint.
 */

interface OwnerSource {
  getOwnerWallet(): string | null;
}

const DASHBOARD_PATH_HTML = '/_dashboard';
const DASHBOARD_PATH_JSON = '/_dashboard.json';

/**
 * Public matcher used by the http server's request listener to decide
 * whether to delegate to this module. Returns true for any request whose
 * path (ignoring query string) is `/_dashboard` or `/_dashboard.json`.
 */
export function isDashboardRequest(req: IncomingMessage): boolean {
  if (req.method !== 'GET') return false;
  const url = req.url ?? '';
  const pathOnly = url.split('?')[0];
  return pathOnly === DASHBOARD_PATH_HTML || pathOnly === DASHBOARD_PATH_JSON;
}

/**
 * Per-request authorization. Returns null on success, or a `{ status, body }`
 * tuple to send back when denied. The body is intentionally terse — we
 * don't want a 401 page leaking the token-required hint to a curious
 * unauthenticated visitor.
 */
export function authorizeDashboard(req: IncomingMessage): null | { status: number; body: string } {
  const remote = req.socket.remoteAddress ?? '';
  const isLoopback =
    remote === '127.0.0.1' ||
    remote === '::1' ||
    remote === '::ffff:127.0.0.1';

  // Loopback always wins — keeps `pnpm dev` simple regardless of token state.
  if (isLoopback) return null;

  // Read the token directly from process.env rather than getConfig() so a
  // freshly-rotated token (e.g. an operator updating Railway env without
  // a redeploy that bypasses caching) takes effect on the next request.
  // It's also the only `DASHBOARD_TOKEN` consumer in the process — config
  // memoization buys nothing here.
  const token = process.env.DASHBOARD_TOKEN;
  if (!token || token.length === 0) {
    return { status: 403, body: 'forbidden' };
  }
  // Header-only. Query-string tokens are not accepted — they leak via
  // access logs, Referer headers, and browser history.
  const headerToken = req.headers['x-dashboard-token'];
  const headerValue = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (headerValue === token) return null;
  return { status: 401, body: 'unauthorized' };
}

export interface DashboardSnapshot {
  // Identity
  mode: 'public' | 'autonomous';
  authMode: 'owner' | 'allowlist' | 'open';
  agentName: string;
  agentAssetAddress: string | null;
  ownerWallet: string | null;
  // Worker
  paused: boolean;
  errorStreak: number;
  lastTickAt: string | null;
  dryRun: boolean;
  tickIntervalMs: number;
  maxTxPerTick: number;
  // Memory
  goals: ReturnType<typeof getState>['goals'];
  tasks: ReturnType<typeof getState>['tasks'];
  recentJournal: ReturnType<typeof getState>['journal'];
  // Meta
  generatedAt: string;
}

export function buildSnapshot(ownerSource: OwnerSource): DashboardSnapshot {
  const config = getConfig();
  const state = getState();
  // Show only the most recent 10 journal entries (matches the audit spec
  // and keeps the HTML page readable). Active+open by status; the JSON
  // endpoint surfaces everything if a tool needs it.
  const recentJournal = state.journal.slice(-10);
  return {
    mode: config.AGENT_MODE,
    authMode: config.AGENT_AUTH_MODE!,
    agentName: config.ASSISTANT_NAME,
    agentAssetAddress: config.AGENT_ASSET_ADDRESS ?? null,
    ownerWallet: ownerSource.getOwnerWallet(),
    paused: state.paused,
    errorStreak: state.errorStreak,
    lastTickAt: state.lastTickAt,
    dryRun: config.AUTONOMOUS_DRY_RUN,
    tickIntervalMs: config.TICK_INTERVAL_MS,
    maxTxPerTick: config.MAX_TICK_TX_COUNT,
    goals: state.goals,
    tasks: state.tasks,
    recentJournal,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Render the snapshot as a self-contained HTML page. Plain table layout —
 * no external assets, no JS, no fonts. Anything fancier is operator-style
 * preference and belongs behind a real frontend.
 *
 * Important: ALL user/state-derived strings get HTML-escaped. The page is
 * served owner-only, but a malicious goal/task description (set via the
 * agent's own tool calls or a hand-edited agent-state.json) could
 * otherwise pop arbitrary HTML into the operator's browser.
 */
export function renderDashboardHtml(snap: DashboardSnapshot): string {
  const e = escapeHtml;
  const goals = snap.goals.length === 0
    ? '<tr><td colspan="3"><em>none</em></td></tr>'
    : snap.goals
      .map((g) => `<tr><td><code>${e(g.id)}</code></td><td>${e(g.status)}</td><td>${e(g.description)}</td></tr>`)
      .join('');
  const openTasks = snap.tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
  const tasksHtml = openTasks.length === 0
    ? '<tr><td colspan="4"><em>none</em></td></tr>'
    : openTasks
      .map((t) => `<tr><td><code>${e(t.id)}</code></td><td>${e(t.status)}</td><td><code>${e(t.goalId ?? '—')}</code></td><td>${e(t.description)}</td></tr>`)
      .join('');
  const journal = snap.recentJournal.length === 0
    ? '<tr><td colspan="3"><em>none</em></td></tr>'
    : snap.recentJournal
      .slice()
      .reverse() // newest first in the table
      .map((j) => `<tr><td>${e(j.ts)}</td><td>${e(j.kind)}</td><td>${e(j.summary)}</td></tr>`)
      .join('');

  const dryRunBadge = snap.dryRun
    ? '<span class="badge badge-warn">DRY-RUN</span>'
    : '<span class="badge badge-live">LIVE</span>';
  const pauseBadge = snap.paused
    ? '<span class="badge badge-warn">PAUSED</span>'
    : '<span class="badge badge-ok">RUNNING</span>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${e(snap.agentName)} — dashboard</title>
  <meta name="robots" content="noindex,nofollow">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
    h1 { margin-bottom: 0.25rem; }
    h2 { border-bottom: 1px solid #ddd; padding-bottom: 0.25rem; margin-top: 2rem; }
    .meta { color: #666; font-size: 0.9rem; margin-bottom: 2rem; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
    th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #eee; vertical-align: top; }
    th { background: #fafafa; font-weight: 600; }
    code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.85em; background: #f3f3f3; padding: 0.1rem 0.3rem; border-radius: 3px; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600; margin-right: 0.5rem; }
    .badge-ok { background: #d4f4d4; color: #226622; }
    .badge-warn { background: #fff4cf; color: #8a6500; }
    .badge-live { background: #ffd4d4; color: #8a0000; }
    .stat { display: inline-block; margin-right: 2rem; }
    .stat-label { color: #666; font-size: 0.8rem; text-transform: uppercase; }
    .stat-value { font-size: 1.4rem; font-weight: 600; }
  </style>
</head>
<body>
  <h1>${e(snap.agentName)}</h1>
  <div class="meta">
    ${pauseBadge}${dryRunBadge}
    <code>${e(snap.mode)}</code> mode · auth: <code>${e(snap.authMode)}</code> · generated <code>${e(snap.generatedAt)}</code>
  </div>

  <div>
    <span class="stat"><div class="stat-label">Last tick</div><div class="stat-value">${e(snap.lastTickAt ?? '—')}</div></span>
    <span class="stat"><div class="stat-label">Error streak</div><div class="stat-value">${snap.errorStreak}</div></span>
    <span class="stat"><div class="stat-label">Tick interval</div><div class="stat-value">${Math.round(snap.tickIntervalMs / 1000)}s</div></span>
    <span class="stat"><div class="stat-label">Tx cap / tick</div><div class="stat-value">${snap.maxTxPerTick}</div></span>
  </div>

  <h2>Identity</h2>
  <table>
    <tr><th>Asset address</th><td>${snap.agentAssetAddress ? `<code>${e(snap.agentAssetAddress)}</code>` : '<em>not registered</em>'}</td></tr>
    <tr><th>Owner wallet</th><td>${snap.ownerWallet ? `<code>${e(snap.ownerWallet)}</code>` : '<em>not resolved</em>'}</td></tr>
  </table>

  <h2>Active goals</h2>
  <table>
    <thead><tr><th>ID</th><th>Status</th><th>Description</th></tr></thead>
    <tbody>${goals}</tbody>
  </table>

  <h2>Open tasks</h2>
  <table>
    <thead><tr><th>ID</th><th>Status</th><th>Goal</th><th>Description</th></tr></thead>
    <tbody>${tasksHtml}</tbody>
  </table>

  <h2>Recent journal (last ${snap.recentJournal.length})</h2>
  <table>
    <thead><tr><th>When</th><th>Kind</th><th>Summary</th></tr></thead>
    <tbody>${journal}</tbody>
  </table>
</body>
</html>
`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * HTTP request handler. Call from the http server's 'request' listener
 * after `isDashboardRequest(req)` returns true. Caller is responsible for
 * matching the request — this function assumes it owns the response.
 */
export function handleDashboardRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ownerSource: OwnerSource,
): void {
  const denied = authorizeDashboard(req);
  if (denied) {
    res.writeHead(denied.status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(denied.body);
    return;
  }
  const snap = buildSnapshot(ownerSource);
  const url = req.url ?? '/';
  const pathOnly = url.split('?')[0];
  if (pathOnly === DASHBOARD_PATH_JSON) {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(snap, null, 2));
    return;
  }
  // Default = HTML.
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(renderDashboardHtml(snap));
}
