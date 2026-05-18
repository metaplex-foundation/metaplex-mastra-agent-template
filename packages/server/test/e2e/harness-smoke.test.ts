/**
 * Smoke test for the E2E harness itself: prove that `startTestServer()`
 * boots a real WebSocket server on an ephemeral port and accepts a SIWS
 * authentication round-trip.
 *
 * If this file fails, every other E2E file will too — start your debugging here.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { startTestServer, connectAuthenticated } from '../helpers/e2e-server.js';

test('test server boots, returns an ephemeral port, and accepts SIWS auth', async () => {
  const env = await startTestServer();
  try {
    assert.ok(env.port > 0, 'expected an ephemeral port');
    assert.match(env.url, /^ws:\/\/127\.0\.0\.1:\d+$/);

    const client = await connectAuthenticated(env);
    assert.ok(client.sessionId, 'expected a sessionId after SIWS auth');
    assert.equal(client.walletAddress, env.ownerWallet);
    await client.close();
  } finally {
    await env.close();
  }
});

test('test server can be started multiple times with distinct ports', async () => {
  const a = await startTestServer();
  try {
    const b = await startTestServer();
    try {
      assert.notEqual(a.port, b.port, 'two ephemeral servers should have different ports');
    } finally {
      await b.close();
    }
  } finally {
    await a.close();
  }
});
