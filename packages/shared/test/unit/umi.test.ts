import { test, before, after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { _resetConfigForTests } from '../../src/config.js';
import { createUmi, getAgentKeypairPublicKey } from '../../src/umi.js';

/**
 * Tests for `createUmi()` and `getAgentKeypairPublicKey()` in `src/umi.ts`.
 *
 *  - Keypair decoding (JSON byte-array and base58 secret-key formats).
 *  - Validation error paths (wrong length, malformed JSON) — these are
 *    caught by `getConfig()` (which validates AGENT_KEYPAIR before
 *    `createUmi` ever sees it), so the assertion shape is around the
 *    config-validation message, not a Umi-internal one.
 *  - `getAgentKeypairPublicKey` caching: process-lifetime memo that
 *    survives env mutations. The dynamic-import cache-buster is the
 *    only way to drop it.
 *
 * Note: `createUmi()` does not hit the RPC (the SOLANA_RPC_URL is just
 * stored on the umi instance), so we don't spin up a mock server here.
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
  _resetConfigForTests();
});

after(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v !== undefined) process.env[k] = v;
  }
});

const RPC_URL = 'http://127.0.0.1:9999';

/** Generate a fresh Ed25519 keypair and return the {secretKey, publicKey} pair. */
function freshKeypair() {
  const kp = nacl.sign.keyPair();
  return {
    secretKey: kp.secretKey, // 64-byte Uint8Array
    publicKeyBase58: bs58.encode(kp.publicKey),
  };
}

// ---------------------------------------------------------------------------
// 1. JSON-array keypair format decodes correctly
// ---------------------------------------------------------------------------

test('createUmi decodes a JSON-array AGENT_KEYPAIR and identity matches expected pubkey', async () => {
  const { secretKey, publicKeyBase58 } = freshKeypair();
  const jsonKeypair = JSON.stringify(Array.from(secretKey));

  Object.assign(process.env, {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: jsonKeypair,
    SOLANA_RPC_URL: RPC_URL,
    ANTHROPIC_API_KEY: 'test',
  });

  const umi = createUmi();
  assert.equal(umi.identity.publicKey.toString(), publicKeyBase58);
});

// ---------------------------------------------------------------------------
// 2. Base58-encoded secret-key decodes correctly
// ---------------------------------------------------------------------------

test('createUmi decodes a base58-encoded AGENT_KEYPAIR and identity matches expected pubkey', async () => {
  const { secretKey, publicKeyBase58 } = freshKeypair();
  const base58Keypair = bs58.encode(secretKey);

  Object.assign(process.env, {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: base58Keypair,
    SOLANA_RPC_URL: RPC_URL,
    ANTHROPIC_API_KEY: 'test',
  });

  const umi = createUmi();
  assert.equal(umi.identity.publicKey.toString(), publicKeyBase58);
});

// ---------------------------------------------------------------------------
// 3. Wrong-length JSON array fails validation in getConfig
// ---------------------------------------------------------------------------

test('createUmi throws when AGENT_KEYPAIR JSON array is the wrong length', async () => {
  Object.assign(process.env, {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: '[1,2,3]',
    SOLANA_RPC_URL: RPC_URL,
    ANTHROPIC_API_KEY: 'test',
  });

  // The Zod schema in `config.ts` rejects short byte arrays. createUmi()
  // calls getConfig() first, which throws before we even attempt to decode.
  assert.throws(() => createUmi(), /AGENT_KEYPAIR/);
});

// ---------------------------------------------------------------------------
// 4. Malformed JSON fails validation
// ---------------------------------------------------------------------------

test('createUmi throws when AGENT_KEYPAIR is malformed JSON', async () => {
  Object.assign(process.env, {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: '[invalid',
    SOLANA_RPC_URL: RPC_URL,
    ANTHROPIC_API_KEY: 'test',
  });

  assert.throws(() => createUmi(), /AGENT_KEYPAIR/);
});

// ---------------------------------------------------------------------------
// 5. getAgentKeypairPublicKey is deterministic for a given env
// ---------------------------------------------------------------------------

test('getAgentKeypairPublicKey returns the same value on repeated calls', async () => {
  const { secretKey, publicKeyBase58 } = freshKeypair();

  // Use a fresh module import here so the module-level cache starts empty.
  const bust = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  Object.assign(process.env, {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: JSON.stringify(Array.from(secretKey)),
    SOLANA_RPC_URL: RPC_URL,
    ANTHROPIC_API_KEY: 'test',
  });
  const mod: typeof import('../../src/umi.js') = await import(`../../src/umi.js?bust=${bust}`);

  const first = mod.getAgentKeypairPublicKey();
  const second = mod.getAgentKeypairPublicKey();
  assert.equal(first, publicKeyBase58);
  assert.equal(second, first);
});

// ---------------------------------------------------------------------------
// 6. getAgentKeypairPublicKey is process-lifetime cached (until module reload)
// ---------------------------------------------------------------------------

test('getAgentKeypairPublicKey caches across env mutations, invalidates on module reload', async () => {
  // First keypair → first cached value.
  const a = freshKeypair();
  Object.assign(process.env, {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: JSON.stringify(Array.from(a.secretKey)),
    SOLANA_RPC_URL: RPC_URL,
    ANTHROPIC_API_KEY: 'test',
  });

  const bust1 = `${Date.now()}_${Math.random().toString(36).slice(2)}_1`;
  const mod1: typeof import('../../src/umi.js') = await import(`../../src/umi.js?bust=${bust1}`);
  const cached = mod1.getAgentKeypairPublicKey();
  assert.equal(cached, a.publicKeyBase58);

  // Mutate env without reloading the module — cache holds onto the
  // original value because the keypair is treated as fixed for the
  // process lifetime.
  const b = freshKeypair();
  process.env.AGENT_KEYPAIR = JSON.stringify(Array.from(b.secretKey));
  _resetConfigForTests();
  const stillCached = mod1.getAgentKeypairPublicKey();
  assert.equal(stillCached, a.publicKeyBase58, 'cache survives env mutation');

  // Now reload the module — fresh cache picks up the new env.
  const bust2 = `${Date.now()}_${Math.random().toString(36).slice(2)}_2`;
  // Re-import config with the same bust so the singleton picks up new env;
  // umi.js imports config statically, so we need a fresh config eval too.
  await import(`../../src/config.js?bust=${bust2}`);
  const mod2: typeof import('../../src/umi.js') = await import(`../../src/umi.js?bust=${bust2}`);
  const reloaded = mod2.getAgentKeypairPublicKey();
  assert.equal(reloaded, b.publicKeyBase58, 'fresh import sees new env');
});
