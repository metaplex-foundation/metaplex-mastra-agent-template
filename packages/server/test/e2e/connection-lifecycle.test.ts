/**
 * E2E coverage for connection lifecycle and graceful shutdown.
 *
 * Skipped (with reason):
 *   - "no leak after disconnect during pending tx": the server's pending-tx
 *     map is private and there's no public inspector. The cleanup path is
 *     tested in unit tests by directly invoking `Session.cleanup()`.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { WebSocket } from 'ws';
import { startTestServer, connectAuthenticated, openClient } from '../helpers/e2e-server.js';

test('multiple concurrent clients each receive distinct sessionIds', async () => {
  const env = await startTestServer();
  try {
    const a = await connectAuthenticated(env);
    const b = await connectAuthenticated(env);
    const c = await connectAuthenticated(env);
    assert.notEqual(a.sessionId, b.sessionId);
    assert.notEqual(b.sessionId, c.sessionId);
    assert.notEqual(a.sessionId, c.sessionId);
    await a.close();
    await b.close();
    await c.close();
  } finally {
    await env.close();
  }
});

test('client disconnect during pending tx cleans up the session', async () => {
  // Constrain to a single connection: the test reconnects after disconnect
  // and asserts the reconnect succeeds. With MAX_CONNECTIONS=1 the reconnect
  // can only succeed if the server actually removed the old session — gives
  // us a deterministic cleanup proof without needing to introspect internals.
  const env = await startTestServer({ extraEnv: { MAX_CONNECTIONS: '1' } });
  try {
    const client = await connectAuthenticated(env);
    // Script a tool that opens a pending tx but never gets a response.
    env.agent.setScript([
      {
        kind: 'invoke-tool',
        toolName: 'hang-tx',
        args: {},
        tool: {
          execute: async (_a, { requestContext }) => {
            const rc = requestContext as { get: (k: string) => any };
            const sender = rc.get('transactionSender');
            try {
              await sender.sendAndAwait('TX==', { message: 'await me' });
              return { ok: true };
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) };
            }
          },
        },
      },
    ]);
    client.send({ type: 'message', content: 'start tx' });
    await client.waitFor('transaction');
    // Disconnect without responding. The server should clean up the session
    // (rejecting pending tx and removing from its session map) without
    // throwing or leaking timers.
    const closed = new Promise<void>((resolve) => {
      client.socket.once('close', () => resolve());
    });
    client.socket.close();
    await closed;
    // The session count on the server should drop back. We can't introspect
    // the private sessions map directly, but starting a fresh connection
    // should still succeed — proves the server is healthy.
    const fresh = await connectAuthenticated(env);
    assert.ok(fresh.sessionId);
    await fresh.close();
  } finally {
    await env.close();
  }
});

test('graceful stop() closes all open sockets with 1001', async () => {
  const env = await startTestServer();
  try {
    const a = await connectAuthenticated(env);
    const b = await connectAuthenticated(env);

    const closeA: Promise<number> = new Promise((resolve) => {
      a.socket.once('close', (code) => resolve(code));
    });
    const closeB: Promise<number> = new Promise((resolve) => {
      b.socket.once('close', (code) => resolve(code));
    });

    await env.server.stop();

    const [codeA, codeB] = await Promise.all([closeA, closeB]);
    // Server uses 1001 ("going away") on shutdown.
    assert.equal(codeA, 1001);
    assert.equal(codeB, 1001);
  } finally {
    // Already stopped — env.close() is a no-op for the server but still
    // tears down the mock RPC + restores env.
    await env.close();
  }
});

test('MAX_CONNECTIONS rejects the next client with close 4002', async () => {
  // Cap at 1 connection so we can trigger the cap with a single overflow.
  const env = await startTestServer({ extraEnv: { MAX_CONNECTIONS: '1' } });
  try {
    const first = await connectAuthenticated(env);
    // Second connection should be accepted at the TCP level then immediately
    // closed by the server with code 4002.
    const overflow = await openClient(env);
    const code = await new Promise<number>((resolve) => {
      overflow.socket.once('close', (c) => resolve(c));
    });
    assert.equal(code, 4002);
    await first.close();
  } finally {
    await env.close();
  }
});
