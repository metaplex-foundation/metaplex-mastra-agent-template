/**
 * E2E coverage for the chat message flow.
 *
 * Drives the streaming agent path end-to-end:
 *   client → message → server → stub-agent.stream() → server → message+typing
 *
 * Skipped (with reason):
 *   - Per-wallet rate limit (requires bursting 60+ messages; behavior
 *     verified by unit tests in shared/test/unit/wallet-rate-limit.test.ts).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { startTestServer, connectAuthenticated } from '../helpers/e2e-server.js';

test('authenticated chat: text reply emits typing(true) → message → typing(false)', async () => {
  const env = await startTestServer();
  try {
    const client = await connectAuthenticated(env);
    env.agent.setScript([{ kind: 'text', content: 'hello back' }]);
    client.send({ type: 'message', content: 'hello' });

    // Server emits typing(true) BEFORE invoking the agent.
    const typingOn = await client.waitFor('typing');
    assert.equal(typingOn.isTyping, true);

    // Then the text response surfaces as a `message` (sender: agent).
    const reply = await client.waitFor('message');
    assert.equal(reply.content, 'hello back');
    assert.equal(reply.sender, 'Agent');

    // typing(false) closes the cycle.
    const typingOff = await client.waitFor('typing');
    assert.equal(typingOff.isTyping, false);

    await client.close();
  } finally {
    await env.close();
  }
});

test('chat: agent sees a system-prefix containing the user wallet', async () => {
  const env = await startTestServer();
  try {
    const client = await connectAuthenticated(env);
    env.agent.setScript([{ kind: 'text', content: 'ok' }]);
    client.send({ type: 'message', content: 'plain user content' });
    await client.waitFor('message');

    const messages = env.agent.lastMessages as Array<{ role: string; content: string }>;
    assert.ok(Array.isArray(messages) && messages.length > 0);
    const userTurn = [...messages].reverse().find((m) => m.role === 'user');
    assert.ok(userTurn, 'expected at least one user-role message');
    assert.match(userTurn.content, /User wallet:/);
    assert.match(userTurn.content, /plain user content/);
    await client.close();
  } finally {
    await env.close();
  }
});

test('chat: message content over MAX_MESSAGE_CONTENT is rejected with MESSAGE_TOO_LARGE', async () => {
  const env = await startTestServer({ extraEnv: { MAX_MESSAGE_CONTENT: '32' } });
  try {
    const client = await connectAuthenticated(env);
    client.send({ type: 'message', content: 'x'.repeat(33) });
    const err = await client.waitFor('error');
    assert.equal(err.code, 'MESSAGE_TOO_LARGE');
    assert.match(err.error, /maximum length of 32/);
    await client.close();
  } finally {
    await env.close();
  }
});

test('chat: empty content is silently dropped (no error, no agent invocation)', async () => {
  const env = await startTestServer();
  try {
    const client = await connectAuthenticated(env);
    const beforeCalls = env.agent.callCount;
    client.send({ type: 'message', content: '   ' });
    // Give the server a small window to (not) react.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(env.agent.callCount, beforeCalls, 'whitespace-only messages should not invoke the agent');
    await client.close();
  } finally {
    await env.close();
  }
});

test('chat: malformed message (content not string) returns INVALID_SHAPE', async () => {
  const env = await startTestServer();
  try {
    const client = await connectAuthenticated(env);
    client.send({ type: 'message', content: 12345 });
    const err = await client.waitFor('error');
    assert.equal(err.code, 'INVALID_SHAPE');
    await client.close();
  } finally {
    await env.close();
  }
});
