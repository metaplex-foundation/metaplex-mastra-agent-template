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
import { getTransaction } from '../../../src/tools/shared/get-transaction.js';

/**
 * Integration tests for `get-transaction`.
 *
 * The tool calls `getSignatureStatuses` with `searchTransactionHistory:true`
 * (not `getTransaction` itself — confusingly named tool). Three cases:
 *   - Status returned → success with slot + err
 *   - value[0] is null → info with `found: false`
 *   - Malformed signature → Mastra ValidationError
 */

let rpc: MockRpc;
const AGENT_KEYPAIR = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));
// 88-char base58 signature (within the 64-88 regex). All-'5's are valid base58.
const VALID_SIG = '5'.repeat(88);

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

test('get-transaction returns slot/err on success', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));
  rpc.on('getSignatureStatuses', () => ({
    context: { slot: 1234 },
    value: [{ slot: 1234, confirmationStatus: 'finalized', err: null }],
  }));

  const result = (await getTransaction.execute!(
    { signature: VALID_SIG },
    { requestContext: fakeContext() } as any,
  )) as any;

  assert.equal(result.status, 'success');
  assert.equal(result.signature, VALID_SIG);
  assert.equal(result.found, true);
  assert.equal(result.slot, 1234);
  assert.equal(result.err, null);
});

test('get-transaction returns info status when signature is unknown', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));
  rpc.on('getSignatureStatuses', () => ({
    context: { slot: 1 },
    value: [null],
  }));

  const result = (await getTransaction.execute!(
    { signature: VALID_SIG },
    { requestContext: fakeContext() } as any,
  )) as any;

  assert.equal(result.status, 'info');
  assert.equal(result.found, false);
  assert.match(result.message, /not found/);
});

test('get-transaction returns Mastra ValidationError for malformed signature', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));

  const result = (await getTransaction.execute!(
    { signature: 'too-short' } as any,
    { requestContext: fakeContext() } as any,
  )) as any;

  assert.equal(result.error, true);
  assert.match(result.message, /signature/);
});
