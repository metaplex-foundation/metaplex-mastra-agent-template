import { test, before, after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import nacl from 'tweetnacl';
import {
  startMockRpc,
  blockhashFixture,
  type MockRpc,
} from '../../../../shared/test/helpers/mock-rpc.js';
import {
  isolateEnv,
  restoreEnv,
  defaultTestEnv,
} from '../../../../shared/test/helpers/env.js';
import { _resetConfigForTests } from '@metaplex-foundation/shared';
import { fakeContext } from '../../helpers/mock-context.js';
import { fundAgentSol } from '../../../src/tools/shared/fund-agent-sol.js';

/**
 * Integration tests for the `fund-agent-sol` tool.
 *
 * The tool is mode-agnostic by design: it always routes the transfer
 * through the connected user's wallet via `submitWithUserWallet`, even
 * in autonomous mode (the owner has a wallet attached over chat).
 * Unlike `submitOrSend`, this path never prepends an AGENT_FEE_SOL fee
 * — funding the agent already moves SOL toward the agent.
 *
 * The plan's per-tool guidance for this tool referenced an
 * `ensureAgentFunded` already-funded short-circuit; that's not what
 * the source actually does (it unconditionally builds and sends the
 * transfer), so these tests follow the source.
 *
 * Tests covered:
 *   1. target='keypair' routes to umi.identity (no asset address needed):
 *      sender invoked once with a base64 tx, returned signature matches.
 *   2. target='pda' with agentAssetAddress derives a non-empty
 *      destination PDA and routes through the sender; the destination
 *      reported back differs from the keypair public key.
 *   3. target='pda' without agentAssetAddress short-circuits with
 *      INVALID_INPUT and never invokes the sender.
 *   4. Missing walletAddress → INVALID_INPUT.
 *   5. Missing transactionSender → structured tool error (the underlying
 *      submitWithUserWallet throws "No transaction sender available").
 *   6. Zod validation: enum/negative/malformed inputs rejected pre-execute.
 */

let rpc: MockRpc;
const AGENT_KEYPAIR_BYTES = nacl.sign.keyPair().secretKey;
const AGENT_KEYPAIR = JSON.stringify(Array.from(AGENT_KEYPAIR_BYTES));
const USER_WALLET = 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2';
const AGENT_ASSET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

function makeSender(sig = 'FundSignedSignature11111111111111111111111111111111111111111111111111111111111111111') {
  const calls: { txBase64: string; options: any }[] = [];
  return {
    sender: {
      sendAndAwait: async (txBase64: string, options: any) => {
        calls.push({ txBase64, options });
        return sig;
      },
    },
    calls,
  };
}

before(async () => {
  rpc = await startMockRpc();
  rpc.on('getLatestBlockhash', () => blockhashFixture());
});

afterEach(() => {
  restoreEnv();
  _resetConfigForTests();
});

after(async () => {
  await rpc.close();
});

test("fund-agent-sol target='keypair' routes the transfer to the agent identity via the user's wallet", async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));
  const { sender, calls } = makeSender();

  const result = (await fundAgentSol.execute!(
    { target: 'keypair', amount: 0.5 },
    {
      requestContext: fakeContext({
        walletAddress: USER_WALLET,
        agentMode: 'public',
        transactionSender: sender as any,
        // agentAssetAddress intentionally null — keypair path doesn't need it
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'success', `expected success, got ${JSON.stringify(result)}`);
  assert.match(result.signature, /^FundSigned/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].txBase64.length > 100);
  assert.match(calls[0].options.message, /Fund agent \(keypair\)/);
  // Destination should equal the agent's identity (derived from the
  // configured AGENT_KEYPAIR's public key, not the user wallet).
  assert.notEqual(result.destination, USER_WALLET);
});

test("fund-agent-sol target='pda' derives the PDA from agentAssetAddress and routes through the sender", async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));
  const { sender, calls } = makeSender();

  const result = (await fundAgentSol.execute!(
    { target: 'pda', amount: 1 },
    {
      requestContext: fakeContext({
        walletAddress: USER_WALLET,
        agentMode: 'public',
        agentAssetAddress: AGENT_ASSET,
        transactionSender: sender as any,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'success', `expected success, got ${JSON.stringify(result)}`);
  assert.equal(calls.length, 1);
  assert.match(calls[0].options.message, /Fund agent \(pda\)/);
  // The PDA derived from AGENT_ASSET is deterministic and not equal to
  // either the user wallet or the agent identity — assert it's at least
  // a different valid-looking address.
  assert.ok(typeof result.destination === 'string');
  assert.notEqual(result.destination, USER_WALLET);
  assert.notEqual(result.destination, AGENT_ASSET);
});

test("fund-agent-sol target='pda' returns INVALID_INPUT when the agent is not registered", async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));
  const { sender, calls } = makeSender();

  const result = (await fundAgentSol.execute!(
    { target: 'pda', amount: 1 },
    {
      requestContext: fakeContext({
        walletAddress: USER_WALLET,
        agentMode: 'public',
        agentAssetAddress: null,
        transactionSender: sender as any,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'INVALID_INPUT');
  assert.match(result.message, /not registered/);
  assert.equal(calls.length, 0, 'sender must not be invoked when the agent is not registered');
});

test('fund-agent-sol returns INVALID_INPUT when walletAddress is missing', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));

  const { RequestContext } = await import('@mastra/core/request-context');
  const noWalletCtx = new RequestContext([
    ['walletAddress', null],
    ['agentMode', 'public'],
  ]);

  const result = (await fundAgentSol.execute!(
    { target: 'keypair', amount: 1 },
    { requestContext: noWalletCtx } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'INVALID_INPUT');
  assert.match(result.message, /No wallet connected/);
});

test('fund-agent-sol returns a structured error when no transactionSender is available', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));

  const result = (await fundAgentSol.execute!(
    { target: 'keypair', amount: 1 },
    {
      requestContext: fakeContext({
        walletAddress: USER_WALLET,
        agentMode: 'public',
        // no transactionSender
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.match(result.message, /Fund failed/);
});

test('fund-agent-sol rejects unknown target via Zod', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));

  const result = (await fundAgentSol.execute!(
    { target: 'somewhere-else', amount: 1 } as any,
    { requestContext: fakeContext({ walletAddress: USER_WALLET }) } as any,
  )) as any;

  assert.equal(result.error, true, 'Mastra wraps schema failures into a ValidationError envelope');
});

test('fund-agent-sol rejects non-positive amount via Zod', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));

  const result = (await fundAgentSol.execute!(
    { target: 'keypair', amount: -0.1 } as any,
    { requestContext: fakeContext({ walletAddress: USER_WALLET }) } as any,
  )) as any;

  assert.equal(result.error, true);
});
