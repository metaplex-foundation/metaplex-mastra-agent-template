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
import { buybackToken } from '../../../src/tools/shared/buyback-token.js';

/**
 * Integration tests for the `buyback-token` tool.
 *
 * buyback-token is a SOL → agentToken swap wrapper around `executeSwap`. We
 * exercise the gating logic (registration, token presence, slippage cap,
 * Jupiter HTTP failure) without faking a full Jupiter swap transaction.
 *
 * Tests covered:
 *   1. NOT_REGISTERED when agentAssetAddress is absent.
 *   2. NO_TOKEN when neither tokenOverride nor agentTokenMint is set.
 *   3. tokenOverride takes precedence over agentTokenMint as the buyback
 *      target (confirmed by inspecting the Jupiter outboundMint query).
 *   4. SLIPPAGE_TOO_HIGH when caller exceeds the configured max.
 *   5. Jupiter quote 4xx surfaces as a Buyback-failed structured error.
 *   6. Zod rejects non-positive solAmount.
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

test('buyback-token returns NOT_REGISTERED when agentAssetAddress is missing', async () => {
  const result = (await buybackToken.execute!(
    { solAmount: 0.1 },
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

test('buyback-token returns NO_TOKEN when neither tokenOverride nor agentTokenMint is set', async () => {
  const result = (await buybackToken.execute!(
    { solAmount: 0.1 },
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
  assert.match(result.message, /TOKEN_OVERRIDE|launch-token/);
});

test('buyback-token uses tokenOverride as the outputMint when set', async () => {
  let observedOutputMint: string | undefined;
  const scope = nock('https://api.jup.ag')
    .get('/swap/v1/quote')
    .query((q) => {
      observedOutputMint = q.outputMint as string;
      return true;
    })
    .reply(400, 'no route');

  await buybackToken.execute!(
    { solAmount: 0.1 },
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
  // tokenOverride must win.
  assert.equal(observedOutputMint, OVERRIDE_TOKEN);
});

test('buyback-token uses agentTokenMint when no tokenOverride is set', async () => {
  let observedOutputMint: string | undefined;
  const scope = nock('https://api.jup.ag')
    .get('/swap/v1/quote')
    .query((q) => {
      observedOutputMint = q.outputMint as string;
      return true;
    })
    .reply(400, 'no route');

  await buybackToken.execute!(
    { solAmount: 0.1 },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
        agentTokenMint: AGENT_TOKEN,
      }),
    } as any,
  );

  assert.equal(scope.isDone(), true);
  assert.equal(observedOutputMint, AGENT_TOKEN);
});

test('buyback-token rejects slippage above MAX_SLIPPAGE_BPS', async () => {
  const result = (await buybackToken.execute!(
    { solAmount: 0.1, slippageBps: 9999 },
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

test('buyback-token wraps Jupiter quote 4xx as a structured Buyback-failed error', async () => {
  nock('https://api.jup.ag')
    .get('/swap/v1/quote')
    .query(true)
    .reply(500, 'upstream broken');

  const result = (await buybackToken.execute!(
    { solAmount: 0.1 },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
        agentTokenMint: AGENT_TOKEN,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.match(result.message, /Buyback failed/);
});

test('buyback-token rejects non-positive solAmount via Zod', async () => {
  const result = (await buybackToken.execute!(
    { solAmount: 0 } as any,
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

test('buyback-token converts solAmount to lamports for the Jupiter quote', async () => {
  let observedAmount: string | undefined;
  nock('https://api.jup.ag')
    .get('/swap/v1/quote')
    .query((q) => {
      observedAmount = q.amount as string;
      assert.equal(q.inputMint, SOL_MINT);
      return true;
    })
    .reply(400, 'route unavailable');

  await buybackToken.execute!(
    { solAmount: 0.25 },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
        agentTokenMint: AGENT_TOKEN,
      }),
    } as any,
  );

  // 0.25 SOL = 250_000_000 lamports.
  assert.equal(observedAmount, '250000000');
});
