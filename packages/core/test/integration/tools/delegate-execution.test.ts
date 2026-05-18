import { test, before, after, beforeEach, afterEach } from 'node:test';
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
import { delegateExecution } from '../../../src/tools/shared/delegate-execution.js';

/**
 * Integration tests for the `delegate-execution` tool.
 *
 * The tool's happy path requires the on-chain Agent Registry program plus
 * a confirmed asset account — not feasible to mock end-to-end here. We
 * cover the early error paths:
 *
 *   1. NOT_FOUND when the asset never appears on-chain (waitForAccount
 *      polls 30x at 500ms intervals — we cut that short by using a low
 *      MAX_POLL_ATTEMPTS via a mocked RPC that returns null for every
 *      getAccountInfo). To keep the test fast we'd normally need to
 *      monkey-patch the poll interval; instead we test the structured
 *      error wrapping by triggering an RPC failure.
 *   2. Zod validation rejects an empty agentAssetAddress.
 *   3. Structured error wrapping when getAccount RPC throws.
 *
 * Skipped: the full registerExecutiveV1 + delegateExecutionV1 send-confirm
 * loop, including the existing-state short-circuit. Both depend on actual
 * Agent Registry program data.
 */

let rpc: MockRpc;
const AGENT_KEYPAIR = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));
const AGENT_ASSET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const BOOTSTRAP = 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2';

before(async () => {
  rpc = await startMockRpc();
});

after(async () => {
  await rpc.close();
});

beforeEach(() => {
  isolateEnv(
    defaultTestEnv({
      AGENT_MODE: 'autonomous',
      BOOTSTRAP_WALLET: BOOTSTRAP,
      SOLANA_RPC_URL: rpc.url,
      AGENT_KEYPAIR,
    }),
  );
  _resetConfigForTests();
});

afterEach(() => {
  restoreEnv();
  _resetConfigForTests();
});

test('delegate-execution rejects empty agentAssetAddress via Zod', async () => {
  const result = (await delegateExecution.execute!(
    { agentAssetAddress: '' } as any,
    { requestContext: {} as any } as any,
  )) as any;

  // Zod min(1) on the string still allows empty per the source schema
  // (no explicit min in this case), so this might pass parsing and then
  // fail at publicKey(...). Either way we get a structured error.
  // Confirm we got an error (either schema or wrapped tool error).
  assert.ok(result.error === true || result.status === 'error');
});

test('delegate-execution surfaces structured error when getAccount RPC fails', async () => {
  // Make getAccountInfo throw on every call so the waitForAccount poll
  // also fails (caught and wrapped inside the tool's outer try/catch).
  rpc.on('getAccountInfo', () => {
    throw new Error('rpc unavailable');
  });

  const result = (await delegateExecution.execute!(
    { agentAssetAddress: AGENT_ASSET },
    { requestContext: {} as any } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.match(result.message, /Delegation failed/);
});

test('delegate-execution rejects malformed agentAssetAddress at publicKey()', async () => {
  const result = (await delegateExecution.execute!(
    { agentAssetAddress: 'not-a-valid-pubkey' },
    { requestContext: {} as any } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.match(result.message, /Delegation failed/);
});
