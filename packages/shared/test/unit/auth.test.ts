import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { isolateEnv, restoreEnv, defaultTestEnv } from '../helpers/env.js';
import { _resetConfigForTests } from '../../src/config.js';

/**
 * auth.ts tests.
 *
 * Covers three surfaces:
 *   - `defaultAuthPolicy(level, ctx)` — fail-closed policy with 'public' and 'owner' levels.
 *   - `withAuth(tool, level, policy?)` — in-place execute() wrapper that throws on denial.
 *   - `resolveOwner(addr)` — TTL-cached on-chain owner lookup with BOOTSTRAP_WALLET fallback.
 *
 * Test isolation:
 *   - Each test mutates env then dynamic-imports `auth.js?bust=<unique>` so the module's
 *     `ownerCache` module variable doesn't bleed across cases. The cache-busting URL query
 *     forces ESM to instantiate a fresh module each call (same pattern as state.test.ts).
 *   - `_resetConfigForTests()` is called between cases so per-test BOOTSTRAP_WALLET writes
 *     are picked up by the next `getConfig()` rather than serving a stale singleton.
 *
 * Out of scope here:
 *   - `resolveOwner(addr)` with a non-null asset address would require mocking
 *     `@metaplex-foundation/mpl-core`'s `fetchAsset`, which has the ESM/CJS interop
 *     friction documented in the Task 1.3 implementer notes. Deferred — see case 16.
 */

// Any valid base58 32-byte pubkey works; we never sign with it.
const FIXTURE_BOOTSTRAP = 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2';

beforeEach(() => {
  isolateEnv(
    defaultTestEnv({
      AGENT_MODE: 'autonomous',
      BOOTSTRAP_WALLET: FIXTURE_BOOTSTRAP,
    }),
  );
  _resetConfigForTests();
});

afterEach(() => {
  restoreEnv();
  _resetConfigForTests();
});

async function loadAuthFresh() {
  const bust = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return await import(`../../src/auth.js?bust=${bust}`);
}

// ---------------------------------------------------------------------------
// defaultAuthPolicy
// ---------------------------------------------------------------------------

test('defaultAuthPolicy "public" returns true regardless of wallet context', async () => {
  const { defaultAuthPolicy } = await loadAuthFresh();
  assert.equal(defaultAuthPolicy('public', { connectedWallet: null, ownerWallet: null }), true);
  assert.equal(defaultAuthPolicy('public', { connectedWallet: 'A', ownerWallet: 'B' }), true);
  assert.equal(defaultAuthPolicy('public', { connectedWallet: 'A', ownerWallet: 'A' }), true);
});

test('defaultAuthPolicy "owner" returns true when connectedWallet === ownerWallet', async () => {
  const { defaultAuthPolicy } = await loadAuthFresh();
  assert.equal(
    defaultAuthPolicy('owner', { connectedWallet: 'WalletX', ownerWallet: 'WalletX' }),
    true,
  );
});

test('defaultAuthPolicy "owner" returns false when wallets differ', async () => {
  const { defaultAuthPolicy } = await loadAuthFresh();
  assert.equal(
    defaultAuthPolicy('owner', { connectedWallet: 'WalletA', ownerWallet: 'WalletB' }),
    false,
  );
});

test('defaultAuthPolicy "owner" returns false when connectedWallet is null', async () => {
  const { defaultAuthPolicy } = await loadAuthFresh();
  assert.equal(
    defaultAuthPolicy('owner', { connectedWallet: null, ownerWallet: 'WalletX' }),
    false,
  );
});

test('defaultAuthPolicy "owner" returns false when ownerWallet is null', async () => {
  const { defaultAuthPolicy } = await loadAuthFresh();
  // Both null must also be false — otherwise an un-registered agent would grant owner access.
  assert.equal(
    defaultAuthPolicy('owner', { connectedWallet: 'WalletX', ownerWallet: null }),
    false,
  );
  assert.equal(
    defaultAuthPolicy('owner', { connectedWallet: null, ownerWallet: null }),
    false,
  );
});

test('defaultAuthPolicy unknown level is fail-closed (returns false)', async () => {
  const { defaultAuthPolicy } = await loadAuthFresh();
  assert.equal(
    defaultAuthPolicy('admin', { connectedWallet: 'A', ownerWallet: 'A' }),
    false,
  );
  assert.equal(
    defaultAuthPolicy('', { connectedWallet: 'A', ownerWallet: 'A' }),
    false,
  );
});

// ---------------------------------------------------------------------------
// withAuth
// ---------------------------------------------------------------------------

test('withAuth returns tool unchanged when it has no execute function', async () => {
  const { withAuth } = await loadAuthFresh();
  const tool = { id: 'no-exec' } as { id: string; execute?: any };
  const result = withAuth(tool, 'owner');
  // Same reference, untouched.
  assert.equal(result, tool);
  assert.equal(result.execute, undefined);
});

test('withAuth("public") wraps execute but invokes original on call', async () => {
  const { withAuth } = await loadAuthFresh();
  let called = false;
  const tool = {
    execute: async (args: any, _ctx: any) => {
      called = true;
      return { ok: true, args };
    },
  };
  withAuth(tool, 'public');
  // requestContext is undefined here — public level doesn't consult wallets.
  const out = await tool.execute({ foo: 'bar' }, {});
  assert.equal(called, true);
  assert.deepEqual(out, { ok: true, args: { foo: 'bar' } });
});

test('withAuth("owner") throws with helpful message when wallets do not match', async () => {
  const { withAuth } = await loadAuthFresh();
  let called = false;
  const tool = {
    execute: async () => {
      called = true;
      return 'should-not-run';
    },
  };
  withAuth(tool, 'owner');

  const requestContext = new Map<string, string>([
    ['walletAddress', 'ConnectedWalletAAA'],
    ['ownerWallet', 'DifferentOwnerBBB'],
  ]);

  await assert.rejects(
    () => tool.execute({}, { requestContext }),
    (err: Error) => {
      assert.match(err.message, /owner authorization/);
      assert.match(err.message, /ConnectedWalletAAA/);
      return true;
    },
  );
  assert.equal(called, false, 'original execute must NOT run when denied');
});

test('withAuth("owner") invokes original execute when wallets match', async () => {
  const { withAuth } = await loadAuthFresh();
  let receivedArgs: any = null;
  const tool = {
    execute: async (args: any, _ctx: any) => {
      receivedArgs = args;
      return { signature: 'sig-123' };
    },
  };
  withAuth(tool, 'owner');

  const requestContext = new Map<string, string>([
    ['walletAddress', 'SameWalletXYZ'],
    ['ownerWallet', 'SameWalletXYZ'],
  ]);

  const out = await tool.execute({ amount: 5 }, { requestContext });
  assert.deepEqual(out, { signature: 'sig-123' });
  assert.deepEqual(receivedArgs, { amount: 5 });
});

test('withAuth honors a custom policy that overrides the default', async () => {
  const { withAuth } = await loadAuthFresh();
  let called = false;
  const tool = {
    execute: async () => {
      called = true;
      return 'should-not-run';
    },
  };
  // Always-deny policy — denies even 'public', proving the custom policy replaced the default.
  const denyAll = () => false;
  withAuth(tool, 'public', denyAll);

  await assert.rejects(
    () => tool.execute({}, { requestContext: new Map() }),
    /owner authorization/,
  );
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// resolveOwner
// ---------------------------------------------------------------------------

test('resolveOwner(null) returns BOOTSTRAP_WALLET when env is set', async () => {
  // FIXTURE_BOOTSTRAP is already set by beforeEach.
  const { resolveOwner } = await loadAuthFresh();
  const result = await resolveOwner(null);
  assert.equal(result, FIXTURE_BOOTSTRAP);
});

test('resolveOwner(null) returns null when BOOTSTRAP_WALLET is unset', async () => {
  // Re-isolate without BOOTSTRAP_WALLET. Stay in public mode — autonomous mode
  // fails fast in getConfig() without BOOTSTRAP_WALLET when no asset address is set.
  isolateEnv(defaultTestEnv({ AGENT_MODE: 'public' }));
  _resetConfigForTests();
  const { resolveOwner } = await loadAuthFresh();
  const result = await resolveOwner(null);
  assert.equal(result, null);
});

test('resolveOwner(null) is NEVER cached — env rotation is picked up immediately', async () => {
  // H3: pre-registration fallback re-reads the env on every call.
  const { resolveOwner } = await loadAuthFresh();

  const first = await resolveOwner(null);
  assert.equal(first, FIXTURE_BOOTSTRAP);

  // Rotate BOOTSTRAP_WALLET (and reset config) without re-importing auth.
  // The same auth module instance must reflect the new env value.
  const SECOND_WALLET = 'GokivDYuQXPZCWRkwMhdH2h91KpDQXBEmKgBjFvFnb11';
  process.env.BOOTSTRAP_WALLET = SECOND_WALLET;
  _resetConfigForTests();

  const second = await resolveOwner(null);
  assert.equal(second, SECOND_WALLET, 'rotated BOOTSTRAP_WALLET must be picked up without restart');
});

test('clearOwnerCache is a no-op on an empty cache (no throw, no state)', async () => {
  const { clearOwnerCache, resolveOwner } = await loadAuthFresh();
  // Should not throw with no prior lookup.
  clearOwnerCache();
  clearOwnerCache();
  // Subsequent resolveOwner(null) still works.
  const result = await resolveOwner(null);
  assert.equal(result, FIXTURE_BOOTSTRAP);
});

// Case 16 (resolveOwner(addr) cache + TTL behavior) is intentionally skipped:
// faithful coverage requires mocking `fetchAsset` from `@metaplex-foundation/mpl-core`,
// which has known ESM/CJS interop friction. Deferring rather than modifying source.
