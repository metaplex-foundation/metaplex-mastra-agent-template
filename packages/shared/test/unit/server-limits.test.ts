import { test, before, after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { getServerLimits, _resetLimitsForTests } from '../../src/server-limits.js';

/**
 * Tests for `getServerLimits` (in `src/server-limits.ts`).
 *
 *  - Defaults match what's documented in the schema comments
 *    (AGENT_FUNDING_SOL=0.02, AGENT_FUNDING_THRESHOLD_SOL=0.01,
 *    MAX_TOKENS_PER_MESSAGE=100000, MAX_TOOL_EXECUTIONS_PER_MESSAGE=30).
 *  - Env-coerced overrides win over defaults.
 *  - Zod min/max boundaries throw with the canonical "Invalid
 *    server-limits configuration" prefix so operators can grep logs.
 *  - The module-level `_limits` cache is populated on first call,
 *    served on subsequent calls without re-validating env. We use
 *    `_resetLimitsForTests` (mirrors `_resetConfigForTests`) to bust
 *    the cache between tests, plus a cache-busting fresh import for
 *    the dedicated reload test.
 *
 * Test isolation: env mutations are snapshotted in `before` and
 * restored in `afterEach`, identical to the pattern used in
 * config.test.ts.
 */

const ENV_SNAPSHOT: Record<string, string | undefined> = {};

before(() => {
  for (const k of Object.keys(process.env)) ENV_SNAPSHOT[k] = process.env[k];
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v !== undefined) process.env[k] = v;
  }
  _resetLimitsForTests();
});

after(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v !== undefined) process.env[k] = v;
  }
});

/** Wipe env keys this module reads so we test the *default* path cleanly. */
function clearLimitsEnv(): void {
  delete process.env.AGENT_FUNDING_SOL;
  delete process.env.AGENT_FUNDING_THRESHOLD_SOL;
  delete process.env.MAX_TOKENS_PER_MESSAGE;
  delete process.env.MAX_TOOL_EXECUTIONS_PER_MESSAGE;
}

// ---------------------------------------------------------------------------
// 1. Defaults
// ---------------------------------------------------------------------------

test('getServerLimits returns documented defaults when env is empty', () => {
  clearLimitsEnv();
  const limits = getServerLimits();
  assert.equal(limits.AGENT_FUNDING_SOL, 0.02);
  assert.equal(limits.AGENT_FUNDING_THRESHOLD_SOL, 0.01);
  assert.equal(limits.MAX_TOKENS_PER_MESSAGE, 100000);
  assert.equal(limits.MAX_TOOL_EXECUTIONS_PER_MESSAGE, 30);
});

// ---------------------------------------------------------------------------
// 2. Env-coerced overrides
// ---------------------------------------------------------------------------

test('getServerLimits applies env overrides (string-coerced to number/int)', () => {
  clearLimitsEnv();
  Object.assign(process.env, {
    AGENT_FUNDING_SOL: '0.05',
    AGENT_FUNDING_THRESHOLD_SOL: '0.03',
    MAX_TOKENS_PER_MESSAGE: '50000',
    MAX_TOOL_EXECUTIONS_PER_MESSAGE: '12',
  });
  const limits = getServerLimits();
  assert.equal(limits.AGENT_FUNDING_SOL, 0.05);
  assert.equal(limits.AGENT_FUNDING_THRESHOLD_SOL, 0.03);
  assert.equal(limits.MAX_TOKENS_PER_MESSAGE, 50000);
  assert.equal(limits.MAX_TOOL_EXECUTIONS_PER_MESSAGE, 12);
});

// ---------------------------------------------------------------------------
// 3. AGENT_FUNDING_SOL out of range (max 10)
// ---------------------------------------------------------------------------

test('getServerLimits throws when AGENT_FUNDING_SOL exceeds max', () => {
  clearLimitsEnv();
  process.env.AGENT_FUNDING_SOL = '100';
  assert.throws(
    () => getServerLimits(),
    /Invalid server-limits configuration/,
  );
});

// ---------------------------------------------------------------------------
// 4. Negative AGENT_FUNDING_THRESHOLD_SOL
// ---------------------------------------------------------------------------

test('getServerLimits throws when AGENT_FUNDING_THRESHOLD_SOL is negative', () => {
  clearLimitsEnv();
  process.env.AGENT_FUNDING_THRESHOLD_SOL = '-1';
  assert.throws(
    () => getServerLimits(),
    /Invalid server-limits configuration/,
  );
});

// ---------------------------------------------------------------------------
// 5. MAX_TOKENS_PER_MESSAGE = 0 violates min(1)
// ---------------------------------------------------------------------------

test('getServerLimits throws when MAX_TOKENS_PER_MESSAGE is zero', () => {
  clearLimitsEnv();
  process.env.MAX_TOKENS_PER_MESSAGE = '0';
  assert.throws(
    () => getServerLimits(),
    /Invalid server-limits configuration/,
  );
});

// ---------------------------------------------------------------------------
// 6. Cache holds onto the first computed value across env mutations
// ---------------------------------------------------------------------------

test('getServerLimits caches across env mutations within the same module instance', () => {
  clearLimitsEnv();
  process.env.AGENT_FUNDING_SOL = '0.04';
  const first = getServerLimits();
  assert.equal(first.AGENT_FUNDING_SOL, 0.04);

  // Mutate env — second call should NOT pick up the new value because
  // the limits are fixed for the process lifetime.
  process.env.AGENT_FUNDING_SOL = '0.07';
  const second = getServerLimits();
  assert.equal(second.AGENT_FUNDING_SOL, 0.04, 'second call returns cached value');
  assert.equal(first, second, 'same object reference');
});

// ---------------------------------------------------------------------------
// 7. Cache busted via fresh dynamic import sees the new env
// ---------------------------------------------------------------------------

test('a fresh dynamic import of server-limits.ts re-reads env', async () => {
  clearLimitsEnv();
  process.env.AGENT_FUNDING_SOL = '0.04';
  const first = getServerLimits();
  assert.equal(first.AGENT_FUNDING_SOL, 0.04);

  // Re-import the module with a query-string buster — ESM keys modules
  // by resolved URL, so this gives us a fresh `_limits` cache.
  process.env.AGENT_FUNDING_SOL = '0.08';
  const bust = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const fresh: typeof import('../../src/server-limits.js') = await import(
    `../../src/server-limits.js?bust=${bust}`
  );
  const reloaded = fresh.getServerLimits();
  assert.equal(reloaded.AGENT_FUNDING_SOL, 0.08, 'fresh import sees mutated env');
});
