import { test, before, after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import nacl from 'tweetnacl';
import {
  startMockRpc,
  type MockRpc,
} from '../../../../shared/test/helpers/mock-rpc.js';
import {
  isolateEnv,
  restoreEnv,
  defaultTestEnv,
} from '../../../../shared/test/helpers/env.js';
import { _resetConfigForTests } from '@metaplex-foundation/shared';
import { fakeContext } from '../../helpers/mock-context.js';
import { getBalance } from '../../../src/tools/shared/get-balance.js';

/**
 * Integration tests for the `get-balance` tool.
 *
 * The tool reads `SOLANA_RPC_URL` and `AGENT_KEYPAIR` from the singleton
 * config to build a UMI, then calls `umi.rpc.getBalance(pubkey)`. We
 * stand up an in-process JSON-RPC mock so the call has a real socket on
 * the other end without touching the network.
 *
 * Note on the keypair: `defaultTestEnv` ships `ZERO_KEYPAIR` (all zeros)
 * which fails Ed25519 secret-key validation inside `createUmi`. The
 * tool only needs the keypair for the UMI identity — it doesn't sign
 * anything. We generate a real nacl keypair per test file so the env
 * is valid.
 */

let rpc: MockRpc;
const AGENT_KEYPAIR = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));
const VALID_ADDRESS = 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2';

before(async () => {
  rpc = await startMockRpc();
});

afterEach(() => {
  restoreEnv();
  _resetConfigForTests();
});

after(async () => {
  await rpc.close();
});

test('get-balance returns lamports/SOL on RPC success', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));
  rpc.on('getBalance', () => ({ context: { slot: 1 }, value: 5_000_000_000 }));

  const result = (await getBalance.execute!(
    { address: VALID_ADDRESS },
    { requestContext: fakeContext() } as any,
  )) as any;

  assert.equal(result.status, 'success');
  assert.equal(result.address, VALID_ADDRESS);
  assert.equal(result.balanceSol, 5);
  assert.equal(result.balanceLamports, '5000000000');
  // Verify the RPC was actually consulted via the mock socket.
  assert.ok(
    rpc.calls.some((c) => c.method === 'getBalance'),
    'mock RPC should have received getBalance',
  );
});

test('get-balance returns Mastra ValidationError for malformed address', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));

  // Mastra's wrapper intercepts schema failures and returns a
  // ValidationError object instead of throwing. We assert on that
  // shape: the tool itself is never invoked, so no RPC call is made.
  const result = (await getBalance.execute!(
    { address: 'invalid' } as any,
    { requestContext: fakeContext() } as any,
  )) as any;

  assert.equal(result.error, true);
  assert.match(result.message, /address/);
  assert.match(result.message, /base58/);
});

test('get-balance surfaces RPC failure as structured error', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));
  rpc.on('getBalance', () => {
    throw new Error('node down');
  });

  const result = (await getBalance.execute!(
    { address: VALID_ADDRESS },
    { requestContext: fakeContext() } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.match(result.message, /Failed to get balance/);
});
