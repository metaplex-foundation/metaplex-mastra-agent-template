import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { NonceStore } from '../../src/nonce-store.js';

test('NonceStore.issue produces a 32-hex nonce with iso timestamps', () => {
  const store = new NonceStore({ ttlMs: 60_000 });
  const { nonce, issuedAt, expiresAt } = store.issue();
  assert.match(nonce, /^[0-9a-f]{32}$/);
  assert.equal(typeof issuedAt, 'string');
  assert.equal(new Date(expiresAt).getTime() - new Date(issuedAt).getTime(), 60_000);
});

test('NonceStore.consume succeeds once, fails on replay', () => {
  const store = new NonceStore({ ttlMs: 60_000 });
  const { nonce } = store.issue();
  assert.deepEqual(store.consume(nonce), { ok: true });
  assert.deepEqual(store.consume(nonce), { ok: false, reason: 'nonce_invalid' });
});

test('NonceStore.consume fails after expiry', () => {
  const store = new NonceStore({ ttlMs: 1, now: () => 0 });
  const { nonce } = store.issue();
  store.setNow(() => 100);
  assert.deepEqual(store.consume(nonce), { ok: false, reason: 'nonce_expired' });
});

test('NonceStore.consume fails for unknown nonce', () => {
  const store = new NonceStore({ ttlMs: 60_000 });
  assert.deepEqual(store.consume('deadbeef'), { ok: false, reason: 'nonce_invalid' });
});

test('NonceStore.sweep evicts expired entries and keeps live ones', () => {
  const store = new NonceStore({ ttlMs: 100, now: () => 0 });
  const a = store.issue();
  const b = store.issue();
  assert.equal(store.size(), 2);
  store.setNow(() => 50);
  store.sweep();
  assert.equal(store.size(), 2); // both still live
  store.setNow(() => 200);
  store.sweep();
  assert.equal(store.size(), 0); // both expired and swept
  assert.deepEqual(store.consume(a.nonce), { ok: false, reason: 'nonce_invalid' });
  assert.deepEqual(store.consume(b.nonce), { ok: false, reason: 'nonce_invalid' });
});

test('NonceStore constructor rejects non-positive ttlMs', () => {
  assert.throws(() => new NonceStore({ ttlMs: 0 }), /ttlMs must be a positive finite number/);
  assert.throws(() => new NonceStore({ ttlMs: -1 }), /ttlMs must be a positive finite number/);
});

test('NonceStore constructor rejects NaN and Infinity ttlMs', () => {
  assert.throws(() => new NonceStore({ ttlMs: NaN }), /ttlMs must be a positive finite number/);
  assert.throws(
    () => new NonceStore({ ttlMs: Infinity }),
    /ttlMs must be a positive finite number/,
  );
});

test('NonceStore.issue called concurrently produces 100 distinct nonces', async () => {
  // issue() is synchronous, but wrapping each call in an async function still
  // exercises the "concurrent" call shape — and more importantly asserts that
  // the underlying randomness is wide enough for 100 calls to never collide.
  // 16 bytes = 128 bits of entropy, so collision probability is negligible.
  const store = new NonceStore({ ttlMs: 60_000 });
  const issued = await Promise.all(
    Array.from({ length: 100 }, () => Promise.resolve().then(() => store.issue().nonce)),
  );
  const distinct = new Set(issued);
  assert.equal(distinct.size, 100);
});

test('NonceStore.size() counts expired-not-yet-swept entries', () => {
  // size() is a raw map cardinality, not a live-only count. The contract is
  // "tracked nonces (live + expired-but-not-swept)" — operators rely on this
  // so memory pressure shows up in metrics even before the sweep runs.
  const store = new NonceStore({ ttlMs: 100, now: () => 0 });
  store.issue();
  store.issue();
  store.issue();
  assert.equal(store.size(), 3);
  store.setNow(() => 1000); // well past ttl
  // Deliberately do NOT call sweep().
  assert.equal(store.size(), 3);
});
