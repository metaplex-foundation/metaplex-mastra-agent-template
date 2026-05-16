import { test, before, after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { startMockRpc, blockhashFixture, type MockRpc } from '../helpers/mock-rpc.js';
import { makeTestUmi, stubUmiRpc } from '../helpers/umi.js';
import { _resetConfigForTests } from '../../src/config.js';
import { ensureAgentFunded } from '../../src/funding.js';
import type { AgentContext } from '../../src/types/agent.js';

/**
 * Tests for `ensureAgentFunded` (in `src/funding.ts`).
 *
 *  - Above-threshold balances short-circuit immediately.
 *  - Sub-threshold balances surface a structured `funded: false` result
 *    with the agent address + funding amount in autonomous mode (and in
 *    public mode when no wallet is connected).
 *  - Sub-threshold balances + a connected wallet in public mode trigger
 *    a user-signed top-up via `transactionSender`.
 *
 * Config singleton: as elsewhere in this suite, we snapshot env between
 * tests and call `_resetConfigForTests()` so the next `getConfig()`
 * re-validates. `getServerLimits()` has its own module-level cache, but
 * defaults match what we want for these tests so we don't bust it.
 */

const FIXTURE_WALLET = 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2';

const ENV_SNAPSHOT: Record<string, string | undefined> = {};
let rpc: MockRpc;

before(async () => {
  for (const k of Object.keys(process.env)) ENV_SNAPSHOT[k] = process.env[k];
  rpc = await startMockRpc();
  rpc.on('getLatestBlockhash', () => blockhashFixture());
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v !== undefined) process.env[k] = v;
  }
  _resetConfigForTests();
});

after(async () => {
  await rpc.close();
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v !== undefined) process.env[k] = v;
  }
});

const ZERO_KEYPAIR = '[' + Array.from({ length: 64 }, () => 0).join(',') + ']';

/**
 * Stub `umi.rpc.getBalance` with a configurable lamports-returning callback.
 * Returns `calls` so tests can assert call counts.
 */
function stubBalance(umi: any, lamportsFn: () => bigint): { count: number } {
  const calls = { count: 0 };
  umi.rpc.getBalance = async () => {
    calls.count += 1;
    return { basisPoints: lamportsFn(), identifier: 'SOL', decimals: 9 };
  };
  return calls;
}

// ---------------------------------------------------------------------------
// 1. Balance above threshold short-circuits to { funded: true }
// ---------------------------------------------------------------------------

test('ensureAgentFunded returns { funded: true } immediately when balance is above threshold', async () => {
  Object.assign(process.env, {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    SOLANA_RPC_URL: rpc.url,
    ANTHROPIC_API_KEY: 'test',
  });
  const { umi } = makeTestUmi(rpc.url);
  const rpcCalls = stubUmiRpc(umi);
  // 1 SOL — well above the 0.01 SOL default threshold.
  const balanceCalls = stubBalance(umi, () => 1_000_000_000n);

  const senderCalls: number[] = [];
  const transactionSender = {
    sendAndAwait: async () => {
      senderCalls.push(1);
      return 'should-not-be-called';
    },
  };

  const ctx: AgentContext = {
    walletAddress: FIXTURE_WALLET,
    transactionSender,
    agentMode: 'public',
    agentAssetAddress: null,
    agentTokenMint: null,
    agentFeeSol: 0,
    tokenOverride: null,
    ownerWallet: null,
    txCounter: null,
  };

  const result = await ensureAgentFunded(umi, ctx);
  assert.deepEqual(result, { funded: true });
  assert.equal(balanceCalls.count, 1, 'balance checked once');
  assert.equal(senderCalls.length, 0, 'transactionSender not called');
  assert.equal(rpcCalls.sendTransaction, 0, 'no tx broadcast');
});

// ---------------------------------------------------------------------------
// 2. Autonomous mode + below threshold → unfunded with helpful reason
// ---------------------------------------------------------------------------

test('ensureAgentFunded returns funded:false with agent address and amount in autonomous mode', async () => {
  Object.assign(process.env, {
    AGENT_MODE: 'autonomous',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    BOOTSTRAP_WALLET: FIXTURE_WALLET,
    SOLANA_RPC_URL: rpc.url,
    ANTHROPIC_API_KEY: 'test',
  });
  const { umi, publicKey } = makeTestUmi(rpc.url);
  stubUmiRpc(umi);
  stubBalance(umi, () => 0n);

  const ctx: AgentContext = {
    walletAddress: null,
    transactionSender: null,
    agentMode: 'autonomous',
    agentAssetAddress: null,
    agentTokenMint: null,
    agentFeeSol: 0,
    tokenOverride: null,
    ownerWallet: null,
    txCounter: null,
  };

  const result = await ensureAgentFunded(umi, ctx);
  assert.equal(result.funded, false);
  if (result.funded === false) {
    // The reason string must surface the agent address (so the operator
    // can fund it) and the funding amount (0.02 SOL is the default).
    assert.ok(
      result.reason.includes(publicKey),
      `reason should include agent address, got: ${result.reason}`,
    );
    assert.ok(
      result.reason.includes('0.02'),
      `reason should include funding amount, got: ${result.reason}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Public mode + no transactionSender → unfunded
// ---------------------------------------------------------------------------

test('ensureAgentFunded returns funded:false in public mode when transactionSender is missing', async () => {
  Object.assign(process.env, {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    SOLANA_RPC_URL: rpc.url,
    ANTHROPIC_API_KEY: 'test',
  });
  const { umi, publicKey } = makeTestUmi(rpc.url);
  stubUmiRpc(umi);
  stubBalance(umi, () => 0n);

  const ctx: AgentContext = {
    // walletAddress set but no transactionSender — auto-fund still bails.
    walletAddress: FIXTURE_WALLET,
    transactionSender: null,
    agentMode: 'public',
    agentAssetAddress: null,
    agentTokenMint: null,
    agentFeeSol: 0,
    tokenOverride: null,
    ownerWallet: null,
    txCounter: null,
  };

  const result = await ensureAgentFunded(umi, ctx);
  assert.equal(result.funded, false);
  if (result.funded === false) {
    assert.ok(result.reason.includes(publicKey));
    assert.ok(result.reason.includes('0.02'));
  }
});

// ---------------------------------------------------------------------------
// 4. Public mode + walletAddress + transactionSender → top-up via user
// ---------------------------------------------------------------------------

test('ensureAgentFunded routes a top-up tx through transactionSender in public mode', async () => {
  Object.assign(process.env, {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    SOLANA_RPC_URL: rpc.url,
    ANTHROPIC_API_KEY: 'test',
  });
  const { umi } = makeTestUmi(rpc.url);
  stubUmiRpc(umi);

  // First getBalance returns 0; subsequent calls (the post-submit poll)
  // return 1 SOL so the polling loop exits on its first iteration without
  // waiting on the 1-second setTimeout.
  let balanceCallCount = 0;
  stubBalance(umi, () => {
    balanceCallCount += 1;
    return balanceCallCount === 1 ? 0n : 1_000_000_000n;
  });

  const senderCalls: { txBase64: string; options: any }[] = [];
  const transactionSender = {
    sendAndAwait: async (txBase64: string, options: any) => {
      senderCalls.push({ txBase64, options });
      return 'fake-funding-sig';
    },
  };

  const ctx: AgentContext = {
    walletAddress: FIXTURE_WALLET,
    transactionSender,
    agentMode: 'public',
    agentAssetAddress: null,
    agentTokenMint: null,
    agentFeeSol: 0,
    tokenOverride: null,
    ownerWallet: null,
    txCounter: null,
  };

  const result = await ensureAgentFunded(umi, ctx);
  assert.deepEqual(result, { funded: true });
  assert.equal(senderCalls.length, 1, 'transactionSender called once');
  assert.ok(senderCalls[0].txBase64.length > 0, 'serialized tx is non-empty');
});
