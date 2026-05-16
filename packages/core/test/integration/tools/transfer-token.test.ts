import { test, before, after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import nacl from 'tweetnacl';
import { none } from '@metaplex-foundation/umi';
import { base64 } from '@metaplex-foundation/umi/serializers';
import { getMintAccountDataSerializer } from '@metaplex-foundation/mpl-toolbox';
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
import { transferToken } from '../../../src/tools/public/transfer-token.js';

/**
 * Integration tests for the `transfer-token` tool (public-mode only).
 *
 * The tool's RPC dependencies (beyond `getLatestBlockhash` for tx build):
 *
 *   - `fetchMint(umi, mintPk)` issues a `getAccountInfo` call against the
 *     mint and decodes the 82-byte mint layout to read `decimals`. We
 *     construct a real mint byte fixture with `getMintAccountDataSerializer`
 *     so the decimal-aware amount conversion exercise is realistic.
 *
 *   - `createTokenIfMissing` resolves at build time WITHOUT touching RPC
 *     (it appends a conditional builder that defers the lookup to send
 *     time). Since this code path never broadcasts in public mode — we
 *     just hand the serialized base64 tx to `transactionSender` — we
 *     don't need to mock destination-ATA existence at all.
 *
 *   - `transferTokens` is a synchronous instruction builder.
 *
 * Tests covered:
 *   1. Happy path: real mint fixture (decimals=6), sender stub returns
 *      a fake signature. Assert sender was called once with base64,
 *      tool returns the sender's signature, and the RPC saw one
 *      `getAccountInfo` (for the mint).
 *   2. Missing transactionSender: error wrap.
 *   3. Mint fetch RPC failure: surfaces as a structured tool error.
 *   4. Missing walletAddress: INVALID_INPUT.
 *   5. Zod validation: malformed mint and zero amount rejected
 *      pre-execute.
 */

let rpc: MockRpc;
const AGENT_KEYPAIR = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));
const USER_WALLET = 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2';
const DESTINATION = 'BPFLoaderUpgradeab1e11111111111111111111111';
const MINT = 'So11111111111111111111111111111111111111112';

/**
 * Encode a fake mint account with the given decimals. The byte layout
 * matches what UMI's `deserializeMint` expects so the in-tool
 * `fetchMint(...).decimals` read returns exactly what we wrote.
 */
function encodeMintBase64(decimals: number): string {
  const bytes = getMintAccountDataSerializer().serialize({
    mintAuthority: none(),
    supply: 0n,
    decimals,
    isInitialized: true,
    freezeAuthority: none(),
  });
  return base64.deserialize(bytes)[0];
}

/**
 * RPC `getAccountInfo` envelope for a mint owned by the SPL Token program.
 */
function mintAccountInfoResult(decimals: number) {
  return {
    context: { slot: 1 },
    value: {
      lamports: 1_461_600, // mint rent-exempt minimum (approximate)
      owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      data: [encodeMintBase64(decimals), 'base64'],
      executable: false,
      rentEpoch: 0,
    },
  };
}

function makeSender(sig = 'TokenSignedSignature1111111111111111111111111111111111111111111111111111111111111111') {
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

test('transfer-token fetches mint decimals, builds a tx, and routes through the sender', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));
  // 6 decimals → 100 tokens = 100_000_000 raw units (we don't assert this
  // directly because the raw amount is buried inside the serialized tx —
  // but exercising the decimals math is the point of running through a
  // real mint fixture rather than stubbing the parse path).
  rpc.on('getAccountInfo', () => mintAccountInfoResult(6));
  const { sender, calls } = makeSender();

  const result = (await transferToken.execute!(
    { mint: MINT, destination: DESTINATION, amount: 100 },
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
  assert.match(result.signature, /^TokenSigned/);
  assert.equal(calls.length, 1, 'sender should be invoked exactly once');
  assert.ok(calls[0].txBase64.length > 100);
  assert.match(calls[0].options.message, /Transfer 100 tokens/);
  assert.ok(
    rpc.calls.some((c) => c.method === 'getAccountInfo'),
    'mock RPC should have served the mint getAccountInfo call',
  );
});

test('transfer-token returns a structured error when no transactionSender is available', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));
  rpc.on('getAccountInfo', () => mintAccountInfoResult(9));

  const result = (await transferToken.execute!(
    { mint: MINT, destination: DESTINATION, amount: 1 },
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

test('transfer-token surfaces RPC failure when the mint cannot be fetched', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));
  rpc.on('getAccountInfo', () => {
    throw new Error('rpc down');
  });
  const { sender } = makeSender();

  const result = (await transferToken.execute!(
    { mint: MINT, destination: DESTINATION, amount: 1 },
    {
      requestContext: fakeContext({
        walletAddress: USER_WALLET,
        agentMode: 'public',
        agentFeeSol: 0,
        transactionSender: sender as any,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.match(result.message, /Transfer failed/);
});

test('transfer-token returns INVALID_INPUT when walletAddress is missing', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));

  const { RequestContext } = await import('@mastra/core/request-context');
  const noWalletCtx = new RequestContext([
    ['walletAddress', null],
    ['agentMode', 'public'],
    ['agentFeeSol', 0],
  ]);

  const result = (await transferToken.execute!(
    { mint: MINT, destination: DESTINATION, amount: 1 },
    { requestContext: noWalletCtx } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'INVALID_INPUT');
  assert.match(result.message, /No wallet connected/);
});

test('transfer-token rejects malformed mint via Zod', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));

  const result = (await transferToken.execute!(
    { mint: 'not-a-mint', destination: DESTINATION, amount: 1 } as any,
    { requestContext: fakeContext({ walletAddress: USER_WALLET }) } as any,
  )) as any;

  assert.equal(result.error, true);
  assert.match(result.message, /mint/);
});

test('transfer-token rejects non-positive amount via Zod', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));

  const result = (await transferToken.execute!(
    { mint: MINT, destination: DESTINATION, amount: 0 } as any,
    { requestContext: fakeContext({ walletAddress: USER_WALLET }) } as any,
  )) as any;

  assert.equal(result.error, true);
});

