import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { RequestContext } from '@mastra/core/request-context';
import { readAgentContext } from '../../src/context.js';

/**
 * Tests for `readAgentContext` (in `src/context.ts`).
 *
 *  - Field extraction from a Map-like context (plain Map + the real
 *    Mastra RequestContext).
 *  - Fallback values for missing fields. agentFeeSol uses 0.001 as the
 *    fallback (not null) because every tool expects a number.
 *  - agentMode has no safe default — missing or invalid values throw a
 *    helpful error referencing the public/autonomous tier.
 *  - The `.get()` call is wrapped in a try/catch so a thrower in the
 *    context implementation (rare, but possible in custom runtimes)
 *    doesn't crash the function — it falls back to the default.
 */

const FIXTURE_WALLET = 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2';
const FIXTURE_ASSET = '11111111111111111111111111111112';

// Simple transactionSender + txCounter stand-ins; identity-only.
const sender = { sendAndAwait: async () => 'sig' };
const counter = { count: 0, max: 3 };

// ---------------------------------------------------------------------------
// 1. Reads all fields from a Map-like context
// ---------------------------------------------------------------------------

test('readAgentContext reads all fields from a populated Map', () => {
  const ctx = new Map<string, any>([
    ['walletAddress', FIXTURE_WALLET],
    ['transactionSender', sender],
    ['agentMode', 'public'],
    ['agentAssetAddress', FIXTURE_ASSET],
    ['agentTokenMint', FIXTURE_ASSET],
    ['agentFeeSol', 0.005],
    ['tokenOverride', FIXTURE_ASSET],
    ['ownerWallet', FIXTURE_WALLET],
    ['txCounter', counter],
  ]);

  const result = readAgentContext(ctx);
  assert.equal(result.walletAddress, FIXTURE_WALLET);
  assert.equal(result.transactionSender, sender);
  assert.equal(result.agentMode, 'public');
  assert.equal(result.agentAssetAddress, FIXTURE_ASSET);
  assert.equal(result.agentTokenMint, FIXTURE_ASSET);
  assert.equal(result.agentFeeSol, 0.005);
  assert.equal(result.tokenOverride, FIXTURE_ASSET);
  assert.equal(result.ownerWallet, FIXTURE_WALLET);
  assert.equal(result.txCounter, counter);
});

// ---------------------------------------------------------------------------
// 2. Returns fallbacks for missing fields (only agentMode set)
// ---------------------------------------------------------------------------

test('readAgentContext returns documented fallbacks when fields are missing', () => {
  const ctx = new Map<string, any>([['agentMode', 'autonomous']]);
  const result = readAgentContext(ctx);
  assert.equal(result.walletAddress, null);
  assert.equal(result.transactionSender, null);
  assert.equal(result.agentMode, 'autonomous');
  assert.equal(result.agentAssetAddress, null);
  assert.equal(result.agentTokenMint, null);
  assert.equal(result.agentFeeSol, 0.001);
  assert.equal(result.tokenOverride, null);
  assert.equal(result.ownerWallet, null);
  assert.equal(result.txCounter, null);
});

// ---------------------------------------------------------------------------
// 3. Throws when agentMode is missing
// ---------------------------------------------------------------------------

test('readAgentContext throws a helpful error when agentMode is missing', () => {
  const ctx = new Map<string, any>();
  assert.throws(
    () => readAgentContext(ctx),
    (err: Error) => {
      assert.match(err.message, /agentMode/);
      assert.match(err.message, /public/);
      assert.match(err.message, /autonomous/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 4. Throws when agentMode is an invalid value
// ---------------------------------------------------------------------------

test('readAgentContext throws on invalid agentMode value', () => {
  const ctx = new Map<string, any>([['agentMode', 'invalid']]);
  assert.throws(
    () => readAgentContext(ctx),
    (err: Error) => {
      assert.match(err.message, /agentMode/);
      assert.match(err.message, /public/);
      assert.match(err.message, /autonomous/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 5. A throwing .get() falls back to the default, doesn't propagate
// ---------------------------------------------------------------------------

test('readAgentContext recovers when ctx.get throws for a non-agentMode field', () => {
  // Custom Map subclass that throws on get('agentFeeSol') but returns
  // normally for every other key. Mirrors a hypothetical proxy-based
  // context that fails when a particular field's getter raises.
  const ctx = {
    get(key: string): any {
      if (key === 'agentMode') return 'public';
      if (key === 'agentFeeSol') throw new Error('boom');
      return undefined;
    },
  };
  const result = readAgentContext(ctx);
  // The throw is swallowed and the documented default surfaces.
  assert.equal(result.agentFeeSol, 0.001);
  assert.equal(result.agentMode, 'public');
});

// ---------------------------------------------------------------------------
// 6. Works with the real Mastra RequestContext class
// ---------------------------------------------------------------------------

test('readAgentContext works with the real Mastra RequestContext', () => {
  const ctx = new RequestContext([
    ['walletAddress', FIXTURE_WALLET],
    ['agentMode', 'public'],
    ['agentFeeSol', 0.01],
    ['agentTokenMint', FIXTURE_ASSET],
  ] as Iterable<[string, unknown]>);

  const result = readAgentContext(ctx);
  assert.equal(result.walletAddress, FIXTURE_WALLET);
  assert.equal(result.agentMode, 'public');
  assert.equal(result.agentFeeSol, 0.01);
  assert.equal(result.agentTokenMint, FIXTURE_ASSET);
  // Unset fields fall back as usual.
  assert.equal(result.tokenOverride, null);
});

// ---------------------------------------------------------------------------
// 7. null values use the fallback (not propagate as null when fallback differs)
// ---------------------------------------------------------------------------

test('readAgentContext treats explicit null like missing — falls back to documented default', () => {
  const ctx = new Map<string, any>([
    ['agentMode', 'public'],
    // null fallback IS the default for these — round-trips as null.
    ['agentTokenMint', null],
    // 0.001 is the fallback for agentFeeSol, so null surfaces as 0.001.
    ['agentFeeSol', null],
  ]);
  const result = readAgentContext(ctx);
  assert.equal(result.agentTokenMint, null);
  assert.equal(result.agentFeeSol, 0.001);
});
