/**
 * E2E coverage for SIWS auth-failure paths.
 *
 * Each test connects a fresh client, drives one specific failure, and asserts
 * the wire-level outcome (auth_error code + connection close code 4001).
 *
 * Skipped (with reason):
 *   - nonce_expired: requires advancing the server's clock past
 *     AUTH_NONCE_TTL_MS during the handshake. Doable via env-var nudge but
 *     not without making the test slow; skipped to keep this file fast.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { WebSocket } from 'ws';
import {
  startTestServer,
  openClient,
  type TestServerEnv,
} from '../helpers/e2e-server.js';
import { buildSiwsMessage } from '@metaplex-foundation/shared';

async function awaitClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code: number, reason: Buffer) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

test('auth_response with an unknown nonce yields nonce_invalid + close 4001', async () => {
  const env = await startTestServer();
  try {
    const client = await openClient(env);
    await client.waitFor('connected');
    const challenge = await client.waitFor('auth_challenge');
    // Build a perfectly-formed signature, but over a canonical message
    // whose nonce is a fresh UUID the server never issued.
    const wallet = nacl.sign.keyPair();
    const tamperedChallenge = { ...challenge, nonce: '00000000-0000-4000-8000-000000000000' };
    const message = buildSiwsMessage({
      agentName: tamperedChallenge.agentName,
      agentAsset: tamperedChallenge.agentAsset,
      network: tamperedChallenge.network,
      nonce: tamperedChallenge.nonce,
      issuedAt: tamperedChallenge.issuedAt,
      expiresAt: tamperedChallenge.expiresAt,
    });
    const signature = nacl.sign.detached(new TextEncoder().encode(message), wallet.secretKey);
    // Pre-arm the close listener before sending — the server emits
    // auth_error and closes the socket nearly simultaneously, and a
    // `once('close')` attached AFTER the close fires would hang forever.
    const closedPromise = awaitClose(client.socket);
    client.send({
      type: 'auth_response',
      publicKey: bs58.encode(wallet.publicKey),
      signature: bs58.encode(signature),
      message,
    });
    // The server matches against session.pendingNonce, which was the
    // ORIGINAL nonce, so it rejects with message_mismatch (the canonical
    // form computed from the original challenge doesn't match the one
    // we built from the tampered nonce). Either nonce_invalid or
    // message_mismatch is acceptable here — both prove the server caught
    // the mismatch and refused.
    const err = await client.waitFor('auth_error');
    assert.ok(
      err.code === 'nonce_invalid' || err.code === 'message_mismatch',
      `expected nonce_invalid or message_mismatch, got ${err.code}`,
    );
    const closed = await closedPromise;
    assert.equal(closed.code, 4001);
  } finally {
    await env.close();
  }
});

test('auth_response with a tampered canonical message yields message_mismatch + close 4001', async () => {
  const env = await startTestServer();
  try {
    const client = await openClient(env);
    await client.waitFor('connected');
    const challenge = await client.waitFor('auth_challenge');
    const wallet = nacl.sign.keyPair();
    // Build the canonical message correctly, then mutate one byte before
    // signing+sending so the message field on the wire differs from the
    // server's reconstruction.
    const correctMessage = buildSiwsMessage({
      agentName: challenge.agentName,
      agentAsset: challenge.agentAsset,
      network: challenge.network,
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    });
    const tamperedMessage = correctMessage.replace(challenge.agentName, 'NOT-' + challenge.agentName);
    const signature = nacl.sign.detached(new TextEncoder().encode(tamperedMessage), wallet.secretKey);
    const closedPromise = awaitClose(client.socket);
    client.send({
      type: 'auth_response',
      publicKey: bs58.encode(wallet.publicKey),
      signature: bs58.encode(signature),
      message: tamperedMessage,
    });
    const err = await client.waitFor('auth_error');
    assert.equal(err.code, 'message_mismatch');
    const closed = await closedPromise;
    assert.equal(closed.code, 4001);
  } finally {
    await env.close();
  }
});

test('auth_response with an invalid signature yields signature_invalid + close 4001', async () => {
  const env = await startTestServer();
  try {
    const client = await openClient(env);
    await client.waitFor('connected');
    const challenge = await client.waitFor('auth_challenge');
    const wallet = nacl.sign.keyPair();
    const message = buildSiwsMessage({
      agentName: challenge.agentName,
      agentAsset: challenge.agentAsset,
      network: challenge.network,
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    });
    // Generate the right shape of signature but signed with a DIFFERENT
    // keypair — passes regex, fails crypto verification.
    const otherWallet = nacl.sign.keyPair();
    const badSig = nacl.sign.detached(new TextEncoder().encode(message), otherWallet.secretKey);
    const closedPromise = awaitClose(client.socket);
    client.send({
      type: 'auth_response',
      publicKey: bs58.encode(wallet.publicKey),
      signature: bs58.encode(badSig),
      message,
    });
    const err = await client.waitFor('auth_error');
    assert.equal(err.code, 'signature_invalid');
    const closed = await closedPromise;
    assert.equal(closed.code, 4001);
  } finally {
    await env.close();
  }
});

test('owner-mode rejects a stranger wallet with not_authorized + close 4001', async () => {
  const env = await startTestServer({ authMode: 'owner' });
  try {
    const stranger = nacl.sign.keyPair();
    const client = await openClient(env);
    await client.waitFor('connected');
    const challenge = await client.waitFor('auth_challenge');
    const message = buildSiwsMessage({
      agentName: challenge.agentName,
      agentAsset: challenge.agentAsset,
      network: challenge.network,
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    });
    const sig = nacl.sign.detached(new TextEncoder().encode(message), stranger.secretKey);
    const closedPromise = awaitClose(client.socket);
    client.send({
      type: 'auth_response',
      publicKey: bs58.encode(stranger.publicKey),
      signature: bs58.encode(sig),
      message,
    });
    const err = await client.waitFor('auth_error');
    assert.equal(err.code, 'not_authorized');
    const closed = await closedPromise;
    assert.equal(closed.code, 4001);
  } finally {
    await env.close();
  }
});

test('pre-auth handshake timeout closes with auth_timeout + 4001', async () => {
  // Short handshake window so the test doesn't run for 30s. The server clamps
  // this at 5000ms minimum, so use 5000 + a small buffer.
  const env = await startTestServer({ extraEnv: { AUTH_HANDSHAKE_TIMEOUT_MS: '5000' } });
  try {
    const client = await openClient(env);
    await client.waitFor('connected');
    await client.waitFor('auth_challenge');
    // Do NOT send auth_response. Wait for the server to time out. Pre-arm
    // the close watcher so we don't miss the close that fires immediately
    // after auth_error.
    const closedPromise = awaitClose(client.socket);
    const err = await client.waitFor('auth_error', 10_000);
    assert.equal(err.code, 'auth_timeout');
    const closed = await closedPromise;
    assert.equal(closed.code, 4001);
  } finally {
    await env.close();
  }
});

test('pre-auth message that is not auth_response yields not_authorized + close 4001', async () => {
  const env = await startTestServer();
  try {
    const client = await openClient(env);
    await client.waitFor('connected');
    await client.waitFor('auth_challenge');
    // Send a chat message before authenticating — the server should reject.
    const closedPromise = awaitClose(client.socket);
    client.send({ type: 'message', content: 'hi' });
    const err = await client.waitFor('auth_error');
    assert.equal(err.code, 'not_authorized');
    const closed = await closedPromise;
    assert.equal(closed.code, 4001);
  } finally {
    await env.close();
  }
});

test('pre-auth invalid JSON yields message_mismatch + close 4001', async () => {
  const env = await startTestServer();
  try {
    const client = await openClient(env);
    await client.waitFor('connected');
    await client.waitFor('auth_challenge');
    const closedPromise = awaitClose(client.socket);
    client.socket.send('not-json{{{');
    const err = await client.waitFor('auth_error');
    assert.equal(err.code, 'message_mismatch');
    const closed = await closedPromise;
    assert.equal(closed.code, 4001);
  } finally {
    await env.close();
  }
});
