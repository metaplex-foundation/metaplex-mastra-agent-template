import { test, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import nacl from 'tweetnacl';
import nock from 'nock';
import {
  isolateEnv,
  restoreEnv,
  defaultTestEnv,
} from '../../../../shared/test/helpers/env.js';
import { _resetConfigForTests } from '@metaplex-foundation/shared';
import { fakeContext } from '../../helpers/mock-context.js';
import { swapToken } from '../../../src/tools/shared/swap-token.js';

/**
 * Integration tests for the `swap-token` tool.
 *
 * The tool delegates the heavy lifting to `executeSwap` in
 * `@metaplex-foundation/shared`, which composes the Jupiter quote/swap HTTP
 * endpoints with on-chain signing and confirmation. A full happy-path test
 * would require constructing a real base64 versioned-transaction with the
 * agent keypair as the only required signer plus simulating the on-chain
 * deltas — that level of fixture-building is out of scope for this batch.
 *
 * Instead these tests cover:
 *   1. Early `NOT_REGISTERED` short-circuit when the request context lacks
 *      `agentAssetAddress` — proves the tool refuses to invoke executeSwap
 *      before any HTTP traffic.
 *   2. `SLIPPAGE_TOO_HIGH` cap enforced before any network call.
 *   3. Jupiter quote HTTP failure (4xx) surfaces as a structured error
 *      wrapped with "Swap failed:" — exercises the toToolError path.
 *   4. Zod validation rejects a malformed input mint.
 *   5. Zod validation rejects a non-positive amount.
 */

const AGENT_KEYPAIR = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));
const AGENT_ASSET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const TOKEN_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

before(() => {
  nock.disableNetConnect();
  // Loopback enabled in case anything tries to reach a local RPC fixture.
  nock.enableNetConnect('127.0.0.1');
});

after(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

beforeEach(() => {
  isolateEnv(
    defaultTestEnv({
      AGENT_MODE: 'autonomous',
      BOOTSTRAP_WALLET: 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2',
      AGENT_KEYPAIR,
    }),
  );
  _resetConfigForTests();
});

afterEach(() => {
  restoreEnv();
  _resetConfigForTests();
  nock.cleanAll();
});

test('swap-token returns NOT_REGISTERED when agentAssetAddress is missing', async () => {
  const result = (await swapToken.execute!(
    { inputMint: SOL_MINT, outputMint: TOKEN_MINT, amount: '1000000000' },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: null,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'NOT_REGISTERED');
  assert.match(result.message, /Agent must be registered/);
});

test('swap-token rejects slippage above MAX_SLIPPAGE_BPS without hitting the network', async () => {
  // Default config caps slippage at 500 bps. 9999 must short-circuit.
  const result = (await swapToken.execute!(
    {
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      amount: '1000000000',
      slippageBps: 9999,
    },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'SLIPPAGE_TOO_HIGH');
  assert.match(result.message, /exceeds configured max/);
});

test('swap-token surfaces Jupiter quote HTTP failure as a structured error', async () => {
  const scope = nock('https://api.jup.ag')
    .get('/swap/v1/quote')
    .query(true)
    .reply(400, 'no route available');

  const result = (await swapToken.execute!(
    { inputMint: SOL_MINT, outputMint: TOKEN_MINT, amount: '1000000000' },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.match(result.message, /Swap failed/);
  assert.match(result.message, /no route available|Jupiter quote/);
  assert.equal(scope.isDone(), true);
});

test('swap-token rejects malformed inputMint via Zod', async () => {
  const result = (await swapToken.execute!(
    { inputMint: 'not-a-pubkey', outputMint: TOKEN_MINT, amount: '1000' } as any,
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
      }),
    } as any,
  )) as any;

  assert.equal(result.error, true);
});

test('swap-token rejects non-positive amount via Zod', async () => {
  const result = (await swapToken.execute!(
    { inputMint: SOL_MINT, outputMint: TOKEN_MINT, amount: '0' } as any,
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
      }),
    } as any,
  )) as any;

  assert.equal(result.error, true);
});
