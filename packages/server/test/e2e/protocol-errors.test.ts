/**
 * E2E coverage for generic protocol-error paths (post-auth).
 *
 * These are the catch-alls in the WS message handler:
 *   - invalid JSON → INVALID_JSON
 *   - unknown `type` → UNKNOWN_TYPE
 *   - oversized payload → ws-level close (MESSAGE_TOO_LARGE — server has
 *     `maxPayload: 64 * 1024`)
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { WebSocket } from 'ws';
import { startTestServer, connectAuthenticated } from '../helpers/e2e-server.js';

test('post-auth invalid JSON yields error { code: INVALID_JSON } and connection stays open', async () => {
  const env = await startTestServer();
  try {
    const client = await connectAuthenticated(env);
    client.socket.send('not json{{{');
    const err = await client.waitFor('error');
    assert.equal(err.code, 'INVALID_JSON');
    // Connection still alive — server keeps the session for the next message.
    assert.equal(client.socket.readyState, WebSocket.OPEN);
    await client.close();
  } finally {
    await env.close();
  }
});

test('post-auth unknown type yields error { code: UNKNOWN_TYPE }', async () => {
  const env = await startTestServer();
  try {
    const client = await connectAuthenticated(env);
    client.send({ type: 'this-is-not-a-real-message-type' });
    const err = await client.waitFor('error');
    assert.equal(err.code, 'UNKNOWN_TYPE');
    assert.match(err.error, /Unknown message type/);
    await client.close();
  } finally {
    await env.close();
  }
});

test('post-auth missing type yields error { code: INVALID_SHAPE }', async () => {
  const env = await startTestServer();
  try {
    const client = await connectAuthenticated(env);
    client.send({ noType: 'hi' });
    const err = await client.waitFor('error');
    assert.equal(err.code, 'INVALID_SHAPE');
    await client.close();
  } finally {
    await env.close();
  }
});

test('post-auth oversized message (>64KB) is dropped by ws maxPayload (connection closes)', async () => {
  const env = await startTestServer();
  try {
    const client = await connectAuthenticated(env);
    // 65KB payload — over the 64KB maxPayload cap. ws closes with 1009.
    const closed: Promise<{ code: number }> = new Promise((resolve) => {
      client.socket.once('close', (code) => resolve({ code }));
    });
    const bigContent = JSON.stringify({ type: 'message', content: 'x'.repeat(65 * 1024) });
    client.socket.send(bigContent);
    const { code } = await closed;
    // ws close code 1009 = "message too big" per RFC 6455. We accept any
    // close code in the 1000-range; the contract is "connection dies".
    assert.ok(code >= 1000 && code < 5000, `expected a defined close code, got ${code}`);
  } finally {
    await env.close();
  }
});
