import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { IncomingMessage, ServerResponse } from 'http';
import { Socket } from 'net';

// Build a sufficient AGENT_KEYPAIR for getConfig() to succeed.
const ZERO_KEYPAIR = '[' + Array.from({ length: 64 }, () => 0).join(',') + ']';

const SAVED_ENV: Record<string, string | undefined> = {};

before(() => {
  for (const k of Object.keys(process.env)) SAVED_ENV[k] = process.env[k];
  for (const k of Object.keys(process.env)) delete process.env[k];
  process.env.AGENT_MODE = 'public';
  process.env.AGENT_KEYPAIR = ZERO_KEYPAIR;
  process.env.SOLANA_RPC_URL = 'https://api.devnet.solana.com';
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

after(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v !== undefined) process.env[k] = v;
  }
});

// Lazy import — these modules read process.env at load time, so the
// before() hook must run first. Top-level `import` would race that.
async function loadDashboard() {
  return await import('../src/dashboard.js');
}

function makeReq(opts: {
  method?: string;
  url: string;
  remote?: string;
  headers?: Record<string, string | string[]>;
}): IncomingMessage {
  const socket = new Socket();
  // Override the read-only remoteAddress getter via Object.defineProperty
  // — node's Socket#remoteAddress is computed lazily and we can't set it
  // directly without a real connection.
  Object.defineProperty(socket, 'remoteAddress', {
    value: opts.remote ?? '127.0.0.1',
    configurable: true,
  });
  const req = {
    method: opts.method ?? 'GET',
    url: opts.url,
    headers: opts.headers ?? {},
    socket,
  } as unknown as IncomingMessage;
  return req;
}

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
    },
    end(body: string) {
      captured.body = body;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

test('isDashboardRequest matches /_dashboard and /_dashboard.json', async () => {
  const { isDashboardRequest } = await loadDashboard();
  assert.equal(isDashboardRequest(makeReq({ url: '/_dashboard' })), true);
  assert.equal(isDashboardRequest(makeReq({ url: '/_dashboard.json' })), true);
  assert.equal(isDashboardRequest(makeReq({ url: '/_dashboard?token=x' })), true);
  assert.equal(isDashboardRequest(makeReq({ url: '/dashboard' })), false);
  assert.equal(isDashboardRequest(makeReq({ url: '/' })), false);
  // Non-GET methods are ignored — keeps the HTTP surface minimal.
  assert.equal(isDashboardRequest(makeReq({ url: '/_dashboard', method: 'POST' })), false);
});

test('authorizeDashboard allows loopback requests when DASHBOARD_TOKEN is unset', async () => {
  delete process.env.DASHBOARD_TOKEN;
  const { authorizeDashboard } = await loadDashboard();
  assert.equal(authorizeDashboard(makeReq({ url: '/_dashboard', remote: '127.0.0.1' })), null);
  assert.equal(authorizeDashboard(makeReq({ url: '/_dashboard', remote: '::1' })), null);
  assert.equal(authorizeDashboard(makeReq({ url: '/_dashboard', remote: '::ffff:127.0.0.1' })), null);
});

test('authorizeDashboard rejects non-loopback when DASHBOARD_TOKEN is unset', async () => {
  delete process.env.DASHBOARD_TOKEN;
  const { authorizeDashboard } = await loadDashboard();
  const denied = authorizeDashboard(makeReq({ url: '/_dashboard', remote: '10.0.0.5' }));
  assert.deepEqual(denied, { status: 403, body: 'forbidden' });
});

test('authorizeDashboard accepts ?token= when DASHBOARD_TOKEN matches', async () => {
  process.env.DASHBOARD_TOKEN = 'super-secret-token-123';
  const { authorizeDashboard } = await loadDashboard();
  assert.equal(
    authorizeDashboard(makeReq({ url: '/_dashboard?token=super-secret-token-123', remote: '10.0.0.5' })),
    null,
  );
});

test('authorizeDashboard accepts X-Dashboard-Token header when set', async () => {
  process.env.DASHBOARD_TOKEN = 'super-secret-token-123';
  const { authorizeDashboard } = await loadDashboard();
  assert.equal(
    authorizeDashboard(makeReq({
      url: '/_dashboard',
      remote: '10.0.0.5',
      headers: { 'x-dashboard-token': 'super-secret-token-123' },
    })),
    null,
  );
});

test('authorizeDashboard rejects mismatched tokens with 401', async () => {
  process.env.DASHBOARD_TOKEN = 'real-token-1234567';
  const { authorizeDashboard } = await loadDashboard();
  const denied = authorizeDashboard(makeReq({
    url: '/_dashboard?token=wrong',
    remote: '10.0.0.5',
  }));
  assert.deepEqual(denied, { status: 401, body: 'unauthorized' });
});

test('handleDashboardRequest returns JSON for /_dashboard.json', async () => {
  delete process.env.DASHBOARD_TOKEN;
  const { handleDashboardRequest } = await loadDashboard();
  const { res, captured } = makeRes();
  handleDashboardRequest(
    makeReq({ url: '/_dashboard.json', remote: '127.0.0.1' }),
    res,
    { getOwnerWallet: () => null },
  );
  assert.equal(captured.status, 200);
  assert.match(captured.headers['Content-Type'] ?? '', /application\/json/);
  const parsed = JSON.parse(captured.body);
  assert.equal(typeof parsed, 'object');
  assert.ok('mode' in parsed);
  assert.ok('paused' in parsed);
  assert.ok('errorStreak' in parsed);
  assert.ok(Array.isArray(parsed.recentJournal));
});

test('handleDashboardRequest returns HTML for /_dashboard', async () => {
  delete process.env.DASHBOARD_TOKEN;
  const { handleDashboardRequest } = await loadDashboard();
  const { res, captured } = makeRes();
  handleDashboardRequest(
    makeReq({ url: '/_dashboard', remote: '127.0.0.1' }),
    res,
    { getOwnerWallet: () => null },
  );
  assert.equal(captured.status, 200);
  assert.match(captured.headers['Content-Type'] ?? '', /text\/html/);
  assert.match(captured.body, /<!doctype html>/i);
  assert.match(captured.body, /Active goals/);
  assert.match(captured.body, /Open tasks/);
});

test('handleDashboardRequest sends 401 on auth failure (json)', async () => {
  process.env.DASHBOARD_TOKEN = 'right-token';
  const { handleDashboardRequest } = await loadDashboard();
  const { res, captured } = makeRes();
  handleDashboardRequest(
    makeReq({ url: '/_dashboard.json?token=wrong', remote: '10.0.0.5' }),
    res,
    { getOwnerWallet: () => null },
  );
  assert.equal(captured.status, 401);
});

test('renderDashboardHtml escapes HTML in goal/task descriptions', async () => {
  const { renderDashboardHtml } = await loadDashboard();
  const html = renderDashboardHtml({
    mode: 'autonomous',
    authMode: 'owner',
    agentName: 'Bot <script>',
    agentAssetAddress: null,
    ownerWallet: null,
    paused: false,
    errorStreak: 0,
    lastTickAt: null,
    dryRun: true,
    tickIntervalMs: 300_000,
    maxTxPerTick: 3,
    goals: [{
      id: 'g_1',
      description: '<img src=x onerror=alert(1)>',
      createdAt: '2026-05-01T00:00:00.000Z',
      status: 'active',
    }],
    tasks: [],
    recentJournal: [],
    generatedAt: '2026-05-08T00:00:00.000Z',
  });
  // The angle brackets must be escaped — otherwise the goal description
  // would inject markup into the operator's browser.
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /Bot <script>/);
  assert.match(html, /Bot &lt;script&gt;/);
});
