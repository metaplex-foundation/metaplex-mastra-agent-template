import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { NonceStore } from '../src/nonce-store.js';

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
