import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isAuthorized } from '../src/allowlist.js';

const O = 'OwnerPubkey11111111111111111111111111111111';
const A = 'AllowedPubkey1111111111111111111111111111111';
const B = 'BlockedPubkey1111111111111111111111111111111';

test('owner mode: owner allowed, others blocked', () => {
  assert.equal(isAuthorized({ mode: 'owner', publicKey: O, owner: O, allowlist: [] }), true);
  assert.equal(isAuthorized({ mode: 'owner', publicKey: A, owner: O, allowlist: [A] }), false);
});

test('allowlist mode: owner + listed wallets allowed', () => {
  assert.equal(isAuthorized({ mode: 'allowlist', publicKey: O, owner: O, allowlist: [A] }), true);
  assert.equal(isAuthorized({ mode: 'allowlist', publicKey: A, owner: O, allowlist: [A] }), true);
  assert.equal(isAuthorized({ mode: 'allowlist', publicKey: B, owner: O, allowlist: [A] }), false);
});

test('open mode: any pubkey allowed', () => {
  assert.equal(isAuthorized({ mode: 'open', publicKey: B, owner: O, allowlist: [] }), true);
});

test('owner mode with null owner: nothing allowed (fail-closed)', () => {
  assert.equal(isAuthorized({ mode: 'owner', publicKey: O, owner: null, allowlist: [] }), false);
});
