import { test, before, after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import nock from 'nock';
import nacl from 'tweetnacl';
import {
  isolateEnv,
  restoreEnv,
  defaultTestEnv,
} from '../../../../shared/test/helpers/env.js';
import { _resetConfigForTests } from '@metaplex-foundation/shared';
import { fakeContext } from '../../helpers/mock-context.js';
import { getTokenPrice } from '../../../src/tools/shared/get-token-price.js';

/**
 * Integration tests for `get-token-price`.
 *
 * The tool calls Jupiter's `https://api.jup.ag/price/v3?ids=<mint>`
 * endpoint with the `x-api-key` header when `JUPITER_API_KEY` is set.
 * We mock that endpoint with nock.
 *
 * The no-key path returns an info-status response with `priceUsd: null`
 * — covered in unit tests of the shared config; here we focus on the
 * key-set HTTP behavior. `nock.disableNetConnect()` is a safety net so
 * a missing interceptor surfaces as a test failure rather than a real
 * outbound request.
 */

const AGENT_KEYPAIR = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

before(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});

afterEach(() => {
  restoreEnv();
  _resetConfigForTests();
  nock.cleanAll();
});

after(() => {
  nock.enableNetConnect();
});

test('get-token-price returns parsed price from Jupiter on 200 OK', async () => {
  isolateEnv(defaultTestEnv({ AGENT_KEYPAIR, JUPITER_API_KEY: 'test-key' }));

  const scope = nock('https://api.jup.ag')
    .get('/price/v3')
    .query({ ids: WSOL_MINT })
    .matchHeader('x-api-key', 'test-key')
    .reply(200, {
      data: {
        [WSOL_MINT]: { id: WSOL_MINT, type: 'pool', price: '150.5' },
      },
    });

  const result = (await getTokenPrice.execute!(
    { mintAddress: WSOL_MINT },
    { requestContext: fakeContext() } as any,
  )) as any;

  assert.equal(result.status, 'success');
  assert.equal(result.mint, WSOL_MINT);
  assert.equal(result.priceUsd, 150.5);
  assert.equal(result.source, 'jupiter');
  assert.ok(scope.isDone(), 'nock interceptor must have been consumed');
});

test('get-token-price returns info status with null price on Jupiter 4xx', async () => {
  isolateEnv(defaultTestEnv({ AGENT_KEYPAIR, JUPITER_API_KEY: 'test-key' }));

  nock('https://api.jup.ag')
    .get('/price/v3')
    .query({ ids: WSOL_MINT })
    .reply(429, { error: 'rate limited' });

  const result = (await getTokenPrice.execute!(
    { mintAddress: WSOL_MINT },
    { requestContext: fakeContext() } as any,
  )) as any;

  // The tool's `info()` branch handles non-2xx by returning a "no price"
  // payload, not an error — Jupiter is best-effort and the LLM should
  // continue without it.
  assert.equal(result.status, 'info');
  assert.equal(result.priceUsd, null);
  assert.match(result.message, /HTTP 429/);
});
