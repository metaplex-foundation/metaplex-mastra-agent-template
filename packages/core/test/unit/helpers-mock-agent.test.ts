import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { makeStubAgent } from '../helpers/mock-agent.js';
import { fakeContext } from '../helpers/mock-context.js';

test('stub agent invokes scripted tools in order', async () => {
  const calls: string[] = [];
  const tools = {
    foo: { execute: async (args: any) => { calls.push(`foo(${args.x})`); return 'ok'; } },
    bar: { execute: async () => { calls.push('bar'); return 42; } },
  };
  const agent = makeStubAgent(tools);
  agent.setScript([
    { type: 'tool-call', toolName: 'foo', args: { x: 1 } },
    { type: 'text', content: 'between' },
    { type: 'tool-call', toolName: 'bar', args: {} },
  ]);

  const result = await agent.generate('prompt', { requestContext: fakeContext() });
  assert.deepEqual(calls, ['foo(1)', 'bar']);
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[1].result, 42);
  assert.equal(result.text, 'between');
});

test('stub agent throws when scripted tool not registered', async () => {
  const agent = makeStubAgent({});
  agent.setScript([{ type: 'tool-call', toolName: 'missing', args: {} }]);
  await assert.rejects(
    () => agent.generate('prompt', { requestContext: fakeContext() }),
    /missing/,
  );
});

test('fakeContext exposes typed accessors via RequestContext', () => {
  const ctx = fakeContext({ walletAddress: 'CustomWallet', agentMode: 'autonomous' });
  assert.equal(ctx.get('walletAddress'), 'CustomWallet');
  assert.equal(ctx.get('agentMode'), 'autonomous');
  assert.equal(ctx.get('agentFeeSol'), 0);
  assert.equal(ctx.has('txCounter'), false);
});
