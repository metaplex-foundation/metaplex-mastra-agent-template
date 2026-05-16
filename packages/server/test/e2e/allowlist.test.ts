/**
 * E2E coverage for allowlist administration over the WS protocol.
 *
 * Allowlist admin requires the on-chain owner wallet. In the test env that's
 * `env.ownerWallet` (which `BOOTSTRAP_WALLET` is set to). Non-owner wallets
 * authenticated via `allowlist` mode should receive `allowlist_error:
 * not_authorized` for any admin op.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { startTestServer, connectAuthenticated } from '../helpers/e2e-server.js';

const VALID_BASE58_WALLET = 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2';

test('owner adds and lists wallets', async () => {
  // Pre-seed an env wallet so the test can verify both file and env entries
  // surface in the snapshot.
  const envWallet = bs58.encode(nacl.sign.keyPair().publicKey);
  const env = await startTestServer({ authMode: 'allowlist', allowlist: [envWallet] });
  try {
    const owner = await connectAuthenticated(env);

    // List request first — should return the env-seeded wallet plus an empty file.
    owner.send({ type: 'allowlist_list' });
    const list1 = await owner.waitFor('allowlist_state');
    assert.deepEqual(list1.wallets, []); // file empty
    assert.deepEqual(list1.envWallets, [envWallet]);

    // Add a new wallet.
    const added = bs58.encode(nacl.sign.keyPair().publicKey);
    owner.send({ type: 'allowlist_add', pubkey: added });
    const list2 = await owner.waitFor('allowlist_state');
    assert.ok(list2.wallets.includes(added), `expected ${added} in ${list2.wallets.join(',')}`);

    await owner.close();
  } finally {
    await env.close();
  }
});

test('owner removes a wallet', async () => {
  const env = await startTestServer({ authMode: 'allowlist' });
  try {
    const owner = await connectAuthenticated(env);
    const target = bs58.encode(nacl.sign.keyPair().publicKey);

    owner.send({ type: 'allowlist_add', pubkey: target });
    await owner.waitFor('allowlist_state');
    owner.send({ type: 'allowlist_remove', pubkey: target });
    const list = await owner.waitFor('allowlist_state');
    assert.equal(list.wallets.includes(target), false);

    await owner.close();
  } finally {
    await env.close();
  }
});

test('non-owner cannot add to allowlist (allowlist_error: not_authorized)', async () => {
  // Pre-allowlist a stranger wallet so it can authenticate, then try to
  // mutate the allowlist as a non-owner.
  const stranger = nacl.sign.keyPair();
  const strangerPk = bs58.encode(stranger.publicKey);
  const env = await startTestServer({ authMode: 'allowlist', allowlist: [strangerPk] });
  try {
    const client = await connectAuthenticated(env, stranger);
    client.send({ type: 'allowlist_add', pubkey: VALID_BASE58_WALLET });
    const err = await client.waitFor('allowlist_error');
    assert.equal(err.code, 'not_authorized');
    await client.close();
  } finally {
    await env.close();
  }
});

test('allowlist admin in wrong mode returns wrong_auth_mode', async () => {
  // Default authMode=open. Owner can authenticate but the admin protocol
  // refuses to mutate because the allowlist is unused.
  const env = await startTestServer({ authMode: 'open' });
  try {
    const owner = await connectAuthenticated(env);
    owner.send({ type: 'allowlist_add', pubkey: VALID_BASE58_WALLET });
    const err = await owner.waitFor('allowlist_error');
    assert.equal(err.code, 'wrong_auth_mode');
    await owner.close();
  } finally {
    await env.close();
  }
});

test('invalid pubkey on allowlist_add returns bad_pubkey', async () => {
  const env = await startTestServer({ authMode: 'allowlist' });
  try {
    const owner = await connectAuthenticated(env);
    owner.send({ type: 'allowlist_add', pubkey: 'not-a-valid-base58-address-because-too-short' });
    const err = await owner.waitFor('allowlist_error');
    assert.equal(err.code, 'bad_pubkey');
    await owner.close();
  } finally {
    await env.close();
  }
});

test('removing an env-supplied wallet returns env_only', async () => {
  const envWallet = bs58.encode(nacl.sign.keyPair().publicKey);
  const env = await startTestServer({ authMode: 'allowlist', allowlist: [envWallet] });
  try {
    const owner = await connectAuthenticated(env);
    owner.send({ type: 'allowlist_remove', pubkey: envWallet });
    const err = await owner.waitFor('allowlist_error');
    assert.equal(err.code, 'env_only');
    await owner.close();
  } finally {
    await env.close();
  }
});
