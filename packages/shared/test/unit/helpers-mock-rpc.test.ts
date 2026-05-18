import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { startMockRpc, blockhashFixture } from '../helpers/mock-rpc.js';

test('mock RPC routes by method and records calls', async () => {
  const rpc = await startMockRpc();
  rpc.on('getLatestBlockhash', () => blockhashFixture());

  const res = await fetch(rpc.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] }),
  });
  const body = await res.json() as { result: { value: { blockhash: string } } };
  assert.equal(body.result.value.blockhash, '11111111111111111111111111111111');
  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].method, 'getLatestBlockhash');

  await rpc.close();
});

test('mock RPC returns JSON-RPC error for unhandled methods', async () => {
  const rpc = await startMockRpc();
  const res = await fetch(rpc.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSomethingMissing', params: [] }),
  });
  const body = await res.json() as { error: { code: number } };
  assert.equal(body.error.code, -32601);
  await rpc.close();
});
