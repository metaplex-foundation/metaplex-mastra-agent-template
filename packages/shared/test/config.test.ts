import { test, before, after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

/**
 * Config-module loading is gnarly because:
 *   1. The module is ESM, so `require.cache` busting (per the plan's CJS sketch)
 *      doesn't apply — we use dynamic `import()` with a query-string buster.
 *      ESM module identity is keyed by the resolved URL, so `?bust=N` returns a
 *      fresh evaluation each time.
 *   2. `getConfig()` memoizes a `_config` singleton at module scope — busting
 *      the module is the *only* way to force re-validation against new env vars.
 *   3. We rewrite `process.env` per test, so we snapshot the pre-test env and
 *      restore it after each test (and after the file). Without this, mutations
 *      leak across tests in this file.
 *
 * Test-file isolation: `node --test` spawns each test file in its own worker
 * process (Node ≥ 20), so process.env mutations here don't bleed into
 * sibling test files (siws.test.ts, allowlist.test.ts, ...).
 */

const ENV_SNAPSHOT: Record<string, string | undefined> = {};

before(() => {
  // Snapshot the entire process.env so we can restore it after the file runs.
  for (const k of Object.keys(process.env)) ENV_SNAPSHOT[k] = process.env[k];
});

afterEach(() => {
  // Reset env to the snapshot between tests so each one starts clean.
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v !== undefined) process.env[k] = v;
  }
});

after(() => {
  // Final restore (defensive — afterEach already does this).
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v !== undefined) process.env[k] = v;
  }
});

/**
 * Wipe process.env, install the supplied env, and dynamically re-import the
 * config module with a query-string cache buster so the `_config` singleton is
 * evaluated fresh against the new env.
 */
async function load(env: Record<string, string>) {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  // Each call gets a unique URL so ESM treats it as a new module instance.
  const bust = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return await import(`../src/config.js?bust=${bust}`);
}

const ZERO_KEYPAIR = '[' + Array.from({ length: 64 }, () => 0).join(',') + ']';

test('AGENT_AUTH_MODE defaults to owner in autonomous mode', async () => {
  const { getConfig } = await load({
    AGENT_MODE: 'autonomous',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    BOOTSTRAP_WALLET: 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2',
    ANTHROPIC_API_KEY: 'test',
  });
  assert.equal(getConfig().AGENT_AUTH_MODE, 'owner');
});

test('AGENT_AUTH_MODE defaults to allowlist when WALLET_ALLOWLIST set in public mode', async () => {
  const { getConfig } = await load({
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    WALLET_ALLOWLIST: 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2',
    ANTHROPIC_API_KEY: 'test',
  });
  assert.equal(getConfig().AGENT_AUTH_MODE, 'allowlist');
});

test('AGENT_AUTH_MODE defaults to open in public mode without WALLET_ALLOWLIST', async () => {
  const { getConfig } = await load({
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    ANTHROPIC_API_KEY: 'test',
  });
  assert.equal(getConfig().AGENT_AUTH_MODE, 'open');
});

test('AGENT_AUTH_MODE defaults to allowlist when only the file source has entries', async () => {
  // Operator populates wallets.allowlist.json but leaves WALLET_ALLOWLIST env
  // empty. The resolver must consult the file via AllowlistFile so the default
  // resolves to 'allowlist', not 'open'.
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'config-allowlist-'));
  const path = join(dir, 'wallets.allowlist.json');
  writeFileSync(
    path,
    JSON.stringify({ wallets: ['AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2'] }),
  );

  const { getConfig } = await load({
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    WALLET_ALLOWLIST_PATH: path,
    ANTHROPIC_API_KEY: 'test',
  });
  assert.equal(getConfig().AGENT_AUTH_MODE, 'allowlist');
});
