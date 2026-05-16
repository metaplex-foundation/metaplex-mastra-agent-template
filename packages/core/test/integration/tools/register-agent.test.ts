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
import { fakeContext } from '../../helpers/mock-context.js';
import { registerAgent } from '../../../src/tools/shared/register-agent.js';

/**
 * Integration tests for the `register-agent` tool.
 *
 * Full mintAndSubmit flow requires the Agent Registry program to be
 * available — the per-tool guidance authorizes skipping it. These tests
 * cover:
 *   1. Idempotent short-circuit when agentAssetAddress is already set.
 *   2. INSUFFICIENT_FUNDS when the agent keypair balance is below the
 *      funding threshold in autonomous mode (cannot self-fund).
 *   3. RPC failure during balance fetch surfaces as a structured error.
 *   4. Zod validation rejects empty name/description.
 *
 * Skipped: the actual mintAndSubmitAgent call against a real Agent Registry
 * fixture, and the public-mode auto-fund flow (which requires a working
 * transactionSender + post-funding balance poll). Both are out of scope
 * for this batch's coverage breadth target.
 */

let rpc: MockRpc;
const AGENT_KEYPAIR = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));
const EXISTING_ASSET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
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

test('register-agent short-circuits with info when agentAssetAddress is already set', async () => {
  const result = (await registerAgent.execute!(
    { name: 'TestBot', description: 'a test agent' },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: EXISTING_ASSET,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'info');
  assert.equal(result.assetAddress, EXISTING_ASSET);
  assert.match(result.message, /already registered/);
});

test('register-agent returns INSUFFICIENT_FUNDS when the keypair balance is zero in autonomous mode', async () => {
  // Mock getBalance to report zero lamports — below funding threshold.
  rpc.on('getBalance', () => ({ context: { slot: 1 }, value: 0 }));

  const result = (await registerAgent.execute!(
    { name: 'TestBot', description: 'a test agent' },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: null,
        // No transactionSender — autonomous mode can't auto-fund.
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'INSUFFICIENT_FUNDS');
  assert.match(result.message, /insufficient SOL/);
});

test('register-agent surfaces structured error when balance RPC fails', async () => {
  rpc.on('getBalance', () => {
    throw new Error('rpc down');
  });

  const result = (await registerAgent.execute!(
    { name: 'TestBot', description: 'a test agent' },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: null,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.match(result.message, /Registration failed/);
});

test('register-agent rejects empty name via Zod', async () => {
  const result = (await registerAgent.execute!(
    { name: '', description: 'a test agent' } as any,
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: null,
      }),
    } as any,
  )) as any;

  assert.equal(result.error, true);
});

test('register-agent rejects malformed metadataUri via Zod', async () => {
  const result = (await registerAgent.execute!(
    {
      name: 'TestBot',
      description: 'a test agent',
      metadataUri: 'not-a-url',
    } as any,
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: null,
      }),
    } as any,
  )) as any;

  assert.equal(result.error, true);
});
