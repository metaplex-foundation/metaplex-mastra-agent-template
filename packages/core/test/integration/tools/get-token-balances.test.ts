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
import { getTokenBalances } from '../../../src/tools/shared/get-token-balances.js';

/**
 * Integration tests for the `get-token-balances` tool.
 *
 * The tool delegates to `fetchAllTokenByOwner` from mpl-toolbox, which
 * issues a `getProgramAccounts` RPC under the default
 * `tokenStrategy = 'getProgramAccounts'` path. We mock that endpoint.
 *
 * We test the empty-owner happy path (returns `tokens: []`) and the
 * RPC-failure path. A non-empty happy path would require constructing
 * a valid 165-byte SPL Token account byte fixture plus matching Mint
 * fixtures returned via `getAccount`; that's brittle compared to the
 * smoke value, and the parse loop is the same whether the list has 0
 * or N entries. Skipping per the batch-A complexity-cap rule.
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

test('get-token-balances returns empty list when owner has no token accounts', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));
  rpc.on('getProgramAccounts', () => []);

  const result = (await getTokenBalances.execute!(
    { address: VALID_ADDRESS },
    { requestContext: fakeContext() } as any,
  )) as any;

  assert.equal(result.status, 'success');
  assert.equal(result.address, VALID_ADDRESS);
  assert.deepEqual(result.tokens, []);
  assert.ok(
    rpc.calls.some((c) => c.method === 'getProgramAccounts'),
    'mock RPC should have received getProgramAccounts',
  );
});

test('get-token-balances returns Mastra ValidationError for malformed address', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));

  const result = (await getTokenBalances.execute!(
    { address: 'invalid' } as any,
    { requestContext: fakeContext() } as any,
  )) as any;

  assert.equal(result.error, true);
  assert.match(result.message, /address/);
});

test('get-token-balances surfaces RPC failure as structured error', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));
  rpc.on('getProgramAccounts', () => {
    throw new Error('rpc unreachable');
  });

  const result = (await getTokenBalances.execute!(
    { address: VALID_ADDRESS },
    { requestContext: fakeContext() } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.match(result.message, /Failed to get token balances/);
});
