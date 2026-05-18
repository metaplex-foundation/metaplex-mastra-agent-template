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
import { transferSol } from '../../../src/tools/public/transfer-sol.js';

/**
 * Integration tests for the `transfer-sol` tool (public-mode only).
 *
 * The tool builds a `transferSol` instruction with the connected user as
 * source, optionally prepends an AGENT_FEE_SOL transfer to the agent PDA
 * when the agent is registered, calls `buildAndSign` on the UMI builder,
 * and routes the serialized base64 tx through `transactionSender.sendAndAwait`
 * for the user to sign client-side. The tool never broadcasts itself —
 * the user's wallet does that after signing.
 *
 * Tests covered:
 *   1. Happy path with no fee prepend (agentFeeSol=0): sender receives
 *      a single base64 string and the tool returns the sender's signature.
 *   2. Fee-prepend path: agentAssetAddress + agentFeeSol set → still one
 *      sender call (single tx with both transfers), tool still returns
 *      the sender's signature.
 *   3. Missing transactionSender in public mode is wrapped into a tool
 *      error (RPC_FAILURE-ish — the underlying message says "No
 *      transaction sender available").
 *   4. Missing walletAddress short-circuits with INVALID_INPUT before
 *      ever touching RPC or sender.
 *   5. Zod validation: negative / zero amounts and malformed destination
 *      addresses produce a Mastra ValidationError envelope, never
 *      reaching `execute`.
 */

let rpc: MockRpc;
const AGENT_KEYPAIR = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));
// A real base58 wallet (43 chars, no 0/O/I/l) for the connected user.
const USER_WALLET = 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2';
const DESTINATION = 'BPFLoaderUpgradeab1e11111111111111111111111';
// Asset address used to derive the agent PDA in the fee-prepend test.
const AGENT_ASSET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

function makeSender(sig = 'UserSignedSignature111111111111111111111111111111111111111111111111111111111111111111') {
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
  // Every tx build path needs a blockhash. Register once — handlers are
  // not cleared between tests, individual tests can override if needed.
  rpc.on('getLatestBlockhash', () => blockhashFixture());
});

afterEach(() => {
  restoreEnv();
  _resetConfigForTests();
});

after(async () => {
  await rpc.close();
});

test('transfer-sol routes a base64 tx through the transactionSender and returns its signature', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));
  const { sender, calls } = makeSender();

  const result = (await transferSol.execute!(
    { destination: DESTINATION, amount: 0.5 },
    {
      requestContext: fakeContext({
        walletAddress: USER_WALLET,
        agentMode: 'public',
        agentFeeSol: 0,
        transactionSender: sender as any,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'success', `expected success, got ${JSON.stringify(result)}`);
  assert.match(result.signature, /^UserSigned/);
  assert.equal(calls.length, 1, 'sender should be invoked exactly once');
  assert.equal(typeof calls[0].txBase64, 'string');
  // Base64 payload should be non-trivially sized — at minimum the wire-format
  // of a one-instruction transferSol is well over 100 bytes raw, ~150+ b64.
  assert.ok(calls[0].txBase64.length > 100, 'base64 tx looks too short');
  assert.match(calls[0].options.message, /Transfer 0\.5 SOL/);
});

test('transfer-sol prepends an AGENT_FEE_SOL transfer when the agent is registered', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));
  const { sender, calls } = makeSender();

  const result = (await transferSol.execute!(
    { destination: DESTINATION, amount: 1 },
    {
      requestContext: fakeContext({
        walletAddress: USER_WALLET,
        agentMode: 'public',
        agentAssetAddress: AGENT_ASSET,
        agentFeeSol: 0.01,
        transactionSender: sender as any,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'success', `expected success, got ${JSON.stringify(result)}`);
  // Still a single submission — the fee is bundled into the same tx, not
  // a second sender round-trip.
  assert.equal(calls.length, 1, 'fee prepend should not produce a second sender call');
  assert.equal(calls[0].options.feeSol, 0.01, 'sender should be told the fee amount');
  // A two-ix tx is meaningfully larger than a one-ix tx (extra accounts +
  // ix metadata). Use a generous lower bound that still distinguishes.
  assert.ok(calls[0].txBase64.length > 200, 'base64 tx with fee prepend should be longer than single-transfer');
});

test('transfer-sol returns a structured error when no transactionSender is available', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));

  const result = (await transferSol.execute!(
    { destination: DESTINATION, amount: 1 },
    {
      requestContext: fakeContext({
        walletAddress: USER_WALLET,
        agentMode: 'public',
        agentFeeSol: 0,
        // no transactionSender
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.match(result.message, /Transfer failed/);
});

test('transfer-sol returns INVALID_INPUT when walletAddress is missing', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));

  // `fakeContext` always supplies a default walletAddress, so build a bare
  // RequestContext that explicitly omits it (null sentinel triggers the
  // INVALID_INPUT short-circuit at the top of execute).
  const { RequestContext } = await import('@mastra/core/request-context');
  const noWalletCtx = new RequestContext([
    ['walletAddress', null],
    ['agentMode', 'public'],
    ['agentFeeSol', 0],
  ]);

  const result = (await transferSol.execute!(
    { destination: DESTINATION, amount: 1 },
    { requestContext: noWalletCtx } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'INVALID_INPUT');
  assert.match(result.message, /No wallet connected/);
});

test('transfer-sol rejects non-positive amount via Zod', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));

  const result = (await transferSol.execute!(
    { destination: DESTINATION, amount: -1 } as any,
    { requestContext: fakeContext({ walletAddress: USER_WALLET }) } as any,
  )) as any;

  assert.equal(result.error, true, 'Mastra wraps schema failures into a ValidationError envelope');
});

test('transfer-sol rejects malformed destination via Zod', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));

  const result = (await transferSol.execute!(
    { destination: 'not-a-valid-address', amount: 1 } as any,
    { requestContext: fakeContext({ walletAddress: USER_WALLET }) } as any,
  )) as any;

  assert.equal(result.error, true);
  assert.match(result.message, /destination/);
});
