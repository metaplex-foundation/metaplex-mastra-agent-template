/**
 * E2E coverage for debug-event emission.
 *
 * The server emits a constellation of `debug:*` messages when
 * `ENABLE_DEBUG_EVENTS=true`:
 *   - debug:context (on auth + after each turn)
 *   - debug:step_start
 *   - debug:tool_call + debug:tool_result (per tool invocation)
 *   - debug:text_delta (per streamed text chunk)
 *   - debug:step_complete (per stream step)
 *   - debug:generation_complete (once per turn)
 *
 * With the flag off, none of `step_start`, `tool_call`, `tool_result`,
 * `text_delta`, `step_complete`, `generation_complete` should be emitted.
 * `debug:context` IS still emitted only when ENABLE_DEBUG_EVENTS is on
 * (server-side `emitContext` short-circuits otherwise).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { startTestServer, connectAuthenticated } from '../helpers/e2e-server.js';
import type { ToolLike } from '../helpers/stub-streaming-agent.js';

test('with ENABLE_DEBUG_EVENTS=true, a tool-call turn emits the full debug suite', async () => {
  const env = await startTestServer({ enableDebugEvents: true });
  try {
    const client = await connectAuthenticated(env);
    // The auth handshake itself triggers a debug:context — drain it.
    await client.waitFor('debug:context');

    const tool: ToolLike = {
      execute: async () => ({ ok: true }),
    };
    env.agent.setScript([
      { kind: 'invoke-tool', toolName: 'noop', args: { x: 1 }, tool, resultText: 'all done' },
    ]);
    client.send({ type: 'message', content: 'go' });

    // typing(true) precedes the debug stream.
    await client.waitFor('typing');
    const stepStart = await client.waitFor('debug:step_start');
    assert.equal(stepStart.step, 1);
    assert.equal(stepStart.stepType, 'initial');

    const toolCall = await client.waitFor('debug:tool_call');
    assert.equal(toolCall.toolName, 'noop');
    assert.deepEqual(toolCall.args, { x: 1 });

    const toolResult = await client.waitFor('debug:tool_result');
    assert.equal(toolResult.toolName, 'noop');
    assert.deepEqual(toolResult.result, { ok: true });
    assert.equal(toolResult.isError, false);

    const textDelta = await client.waitFor('debug:text_delta');
    assert.equal(textDelta.delta, 'all done');

    const stepComplete = await client.waitFor('debug:step_complete');
    assert.equal(stepComplete.step, 1);

    const genComplete = await client.waitFor('debug:generation_complete');
    assert.equal(genComplete.totalSteps, 1);
    assert.ok(typeof genComplete.totalDurationMs === 'number');

    await client.waitFor('message'); // the synthesized reply
    await client.close();
  } finally {
    await env.close();
  }
});

test('with ENABLE_DEBUG_EVENTS=false, debug events are NOT emitted', async () => {
  const env = await startTestServer({ enableDebugEvents: false });
  try {
    const client = await connectAuthenticated(env);
    env.agent.setScript([{ kind: 'text', content: 'hi' }]);
    client.send({ type: 'message', content: 'ping' });

    // Wait for the chat reply to arrive (proves the turn ran end-to-end).
    await client.waitFor('typing');
    await client.waitFor('message');

    // Now scan the received queue: there must be no debug:* messages.
    const debugFrames = client.received.filter((m) => m.type.startsWith('debug:'));
    assert.equal(debugFrames.length, 0, `expected no debug events, got: ${debugFrames.map((m) => m.type).join(',')}`);
    await client.close();
  } finally {
    await env.close();
  }
});
