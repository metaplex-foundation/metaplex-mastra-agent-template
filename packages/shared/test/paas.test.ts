import { test, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectPaas } from '../src/paas.js';

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
