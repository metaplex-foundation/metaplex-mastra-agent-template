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
import { sellToken } from '../../../src/tools/shared/sell-token.js';

/**
 * Integration tests for the `sell-token` tool.
 *
 * sell-token is the inverse of buyback: agentToken → SOL via `executeSwap`.
 * Same Jupiter-mock strategy applies. Tests:
 *   1. NOT_REGISTERED when agentAssetAddress is missing.
 *   2. NO_TOKEN when there's nothing to sell.
 *   3. SLIPPAGE_TOO_HIGH cap.
 *   4. Jupiter 4xx → "Sell failed" wrap.
 *   5. tokenOverride wins as the inputMint for the swap.
 *   6. Zod rejects non-positive tokenAmount.
 */

const AGENT_KEYPAIR = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));
const AGENT_ASSET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const AGENT_TOKEN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OVERRIDE_TOKEN = 'MPLXmpLXmpLXmpLXmpLXmpLXmpLXmpLXmpLXmpLXmpL';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

before(() => {
  nock.disableNetConnect();
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

test('sell-token returns NOT_REGISTERED when agentAssetAddress is missing', async () => {
  const result = (await sellToken.execute!(
    { tokenAmount: '1000' },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: null,
        agentTokenMint: AGENT_TOKEN,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'NOT_REGISTERED');
});

test('sell-token returns NO_TOKEN when no token is configured', async () => {
  const result = (await sellToken.execute!(
    { tokenAmount: '1000' },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
        agentTokenMint: null,
        tokenOverride: null,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'NO_TOKEN');
});

test('sell-token rejects slippage above MAX_SLIPPAGE_BPS', async () => {
  const result = (await sellToken.execute!(
    { tokenAmount: '1000', slippageBps: 9999 },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
        agentTokenMint: AGENT_TOKEN,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'SLIPPAGE_TOO_HIGH');
});

test('sell-token surfaces Jupiter 4xx as a structured Sell-failed error', async () => {
  nock('https://api.jup.ag')
    .get('/swap/v1/quote')
    .query(true)
    .reply(429, 'rate limited');

  const result = (await sellToken.execute!(
    { tokenAmount: '1000' },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
        agentTokenMint: AGENT_TOKEN,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.match(result.message, /Sell failed/);
});

test('sell-token uses tokenOverride as inputMint when set; outputMint is SOL', async () => {
  let observedInput: string | undefined;
  let observedOutput: string | undefined;
  const scope = nock('https://api.jup.ag')
    .get('/swap/v1/quote')
    .query((q) => {
      observedInput = q.inputMint as string;
      observedOutput = q.outputMint as string;
      return true;
    })
    .reply(400, 'no route');

  await sellToken.execute!(
    { tokenAmount: '5000' },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
        agentTokenMint: AGENT_TOKEN,
        tokenOverride: OVERRIDE_TOKEN,
      }),
    } as any,
  );

  assert.equal(scope.isDone(), true);
  assert.equal(observedInput, OVERRIDE_TOKEN);
  assert.equal(observedOutput, SOL_MINT);
});

test('sell-token rejects non-positive tokenAmount via Zod', async () => {
  const result = (await sellToken.execute!(
    { tokenAmount: '0' } as any,
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
        agentTokenMint: AGENT_TOKEN,
      }),
    } as any,
  )) as any;

  assert.equal(result.error, true);
});

test('sell-token rejects non-numeric tokenAmount via Zod', async () => {
  const result = (await sellToken.execute!(
    { tokenAmount: 'abc' } as any,
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
        agentTokenMint: AGENT_TOKEN,
      }),
    } as any,
  )) as any;

  assert.equal(result.error, true);
});
