import { test, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectPaas } from '../../src/paas.js';

const PAAS_KEYS = [
  'RAILWAY_STATIC_URL',
  'RAILWAY_PROJECT_ID',
  'RAILWAY_ENVIRONMENT_NAME',
  'RAILWAY_SERVICE_ID',
  'FLY_APP_NAME',
  'FLY_REGION',
  'RENDER',
  'RENDER_SERVICE_ID',
  'DYNO',
  'HEROKU_APP_ID',
  'KUBERNETES_SERVICE_HOST',
  'K_SERVICE',
];

afterEach(() => {
  // Don't blow away the whole env — only PaaS-related keys, so the test
  // harness's other tooling stays intact across runs.
  for (const k of PAAS_KEYS) delete process.env[k];
});

test('returns unknown when no PaaS env vars are set', () => {
  const result = detectPaas();
  assert.equal(result.platform, 'unknown');
  assert.match(result.label, /local|unknown/i);
});

test('detects Railway from RAILWAY_PROJECT_ID', () => {
  process.env.RAILWAY_PROJECT_ID = 'proj-abc';
  const result = detectPaas();
  assert.equal(result.platform, 'railway');
  assert.match(result.label, /railway/i);
  assert.match(result.instructions, /variable|dashboard/i);
});

test('detects Fly from FLY_APP_NAME', () => {
  process.env.FLY_APP_NAME = 'my-agent';
  const result = detectPaas();
  assert.equal(result.platform, 'fly');
  assert.match(result.instructions, /fly secrets|fly.toml/i);
});

test('detects Render from RENDER', () => {
  process.env.RENDER = 'true';
  const result = detectPaas();
  assert.equal(result.platform, 'render');
  assert.match(result.instructions, /render/i);
});

test('detects Heroku from DYNO', () => {
  process.env.DYNO = 'web.1';
  const result = detectPaas();
  assert.equal(result.platform, 'heroku');
});

test('detects Kubernetes from KUBERNETES_SERVICE_HOST', () => {
  process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
  const result = detectPaas();
  assert.equal(result.platform, 'kubernetes');
});

test('Railway wins over generic K8s when both are set', () => {
  process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
  process.env.RAILWAY_PROJECT_ID = 'proj-abc';
  const result = detectPaas();
  assert.equal(result.platform, 'railway');
});

test('detects Cloud Run from K_SERVICE', () => {
  process.env.K_SERVICE = 'my-service';
  const result = detectPaas();
  assert.equal(result.platform, 'cloud-run');
  assert.match(result.label, /cloud run/i);
  assert.match(result.instructions, /gcloud run/);
});

test('Cloud Run wins over generic K8s when both are set', () => {
  // Cloud Run runs on top of K8s and may inject KUBERNETES_SERVICE_HOST too,
  // but the gcloud workflow (not kubectl) is the correct operator guidance.
  process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
  process.env.K_SERVICE = 'my-service';
  const result = detectPaas();
  assert.equal(result.platform, 'cloud-run');
});

test('detects Render from RENDER_SERVICE_ID alone', () => {
  // RENDER_SERVICE_ID is the alternative hint when RENDER=true is not set
  // (e.g. when operators strip generic flags but Render still injects the
  // service id).
  process.env.RENDER_SERVICE_ID = 'srv-abc';
  const result = detectPaas();
  assert.equal(result.platform, 'render');
});

test('detects Heroku from HEROKU_APP_ID alone', () => {
  // HEROKU_APP_ID is the alternative hint when DYNO is not set (e.g. in
  // one-off runs or build phases where the dyno name hasn't been assigned).
  process.env.HEROKU_APP_ID = 'app-abc';
  const result = detectPaas();
  assert.equal(result.platform, 'heroku');
});

test('every detected platform produces non-empty instructions with a unique marker', () => {
  // Table-driven sanity check: each platform must surface non-empty,
  // platform-specific guidance. Markers are unique substrings of the known
  // instructions — keep this in sync with paas.ts if instruction text changes.
  const cases: { env: Record<string, string>; platform: string; marker: RegExp }[] = [
    { env: { RAILWAY_PROJECT_ID: 'x' }, platform: 'railway', marker: /Railway dashboard/i },
    { env: { FLY_APP_NAME: 'x' }, platform: 'fly', marker: /fly secrets|fly\.toml/ },
    { env: { RENDER: 'true' }, platform: 'render', marker: /Render dashboard/i },
    { env: { DYNO: 'web.1' }, platform: 'heroku', marker: /heroku config:set/ },
    { env: { K_SERVICE: 'svc' }, platform: 'cloud-run', marker: /gcloud run/ },
    { env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' }, platform: 'kubernetes', marker: /Deployment|envFrom/ },
    { env: {}, platform: 'unknown', marker: /\.env/ },
  ];
  for (const c of cases) {
    // afterEach() clears between top-level tests, but inside this loop we have
    // to clear manually so each row sees only its own env.
    for (const k of PAAS_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(c.env)) process.env[k] = v;
    const result = detectPaas();
    assert.equal(result.platform, c.platform, `platform mismatch for ${JSON.stringify(c.env)}`);
    assert.ok(result.instructions.length > 0, `empty instructions for ${c.platform}`);
    assert.match(result.instructions, c.marker, `instructions for ${c.platform} missing marker`);
  }
});
