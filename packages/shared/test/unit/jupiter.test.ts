import { test, beforeEach, afterEach, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import nock from 'nock';
import { isolateEnv, restoreEnv, defaultTestEnv } from '../helpers/env.js';
import { _resetConfigForTests } from '../../src/config.js';
import { getSwapQuote, getSwapTransaction, SOL_MINT } from '../../src/jupiter.js';

/**
 * Jupiter HTTP client tests.
 *
 * These exercise `getSwapQuote` and `getSwapTransaction` against `nock`-mocked
 * Jupiter endpoints. We do NOT cover `simulateAndVerifySwap` or `executeSwap`
 * here — those depend on full UMI + Solana RPC simulation behavior and are
 * deferred to a future integration test pass when richer UMI mocking is
 * available.
 *
 * Setup notes:
 * - `nock.disableNetConnect()` prevents accidental real HTTP traffic. Loopback
 *   is left enabled defensively in case future helpers need it.
 * - `_resetConfigForTests()` is called between tests so per-case env mutations
 *   (e.g. JUPITER_API_KEY, MAX_PRICE_IMPACT_PCT) are picked up by the next
 *   `getConfig()` call rather than serving a stale singleton.
 * - We force `AGENT_MODE=autonomous` + `BOOTSTRAP_WALLET` because the config
 *   loader fails fast in autonomous mode without one of those gating values
 *   set (see config.ts pre-registration gate).
 */

// Any valid base58 32-byte pubkey works here — we never sign with it, the
// config validator just requires the string parses cleanly.
const FIXTURE_WALLET = 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2';

const TOKEN_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WALLET = 'GokivDYuQXPZCWRkwMhdH2h91KpDQXBEmKgBjFvFnb11';

before(() => {
  nock.disableNetConnect();
  // Defensive — none of the cases here need loopback, but if a future
  // helper grows a real RPC call we don't want it to silently hit the
  // wider internet.
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
      BOOTSTRAP_WALLET: FIXTURE_WALLET,
    }),
  );
  _resetConfigForTests();
});

afterEach(() => {
  restoreEnv();
  _resetConfigForTests();
  nock.cleanAll();
});

// ---------------------------------------------------------------------------
// getSwapQuote
// ---------------------------------------------------------------------------

test('getSwapQuote sends correct query params and returns parsed quote', async () => {
  const scope = nock('https://api.jup.ag')
    .get('/swap/v1/quote')
    .query({
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      amount: '1000000000',
      slippageBps: '50',
    })
    .reply(200, {
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      inAmount: '1000000000',
      outAmount: '50000000',
      priceImpactPct: '0.01',
      routePlan: [],
    });

  const quote = await getSwapQuote({
    walletAddress: WALLET,
    inputMint: SOL_MINT,
    outputMint: TOKEN_MINT,
    amount: '1000000000',
  });

  assert.equal(quote.inAmount, '1000000000');
  assert.equal(quote.outAmount, '50000000');
  assert.equal(quote.priceImpactPct, '0.01');
  assert.equal(scope.isDone(), true);
});

test('getSwapQuote defaults slippageBps to 50 when not specified', async () => {
  // The query-matcher in the previous test also covered this implicitly,
  // but make it explicit: caller omits slippageBps -> request includes '50'.
  const scope = nock('https://api.jup.ag')
    .get('/swap/v1/quote')
    .query((q) => q.slippageBps === '50')
    .reply(200, {
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      inAmount: '1',
      outAmount: '1',
      priceImpactPct: '0',
      routePlan: [],
    });

  await getSwapQuote({
    walletAddress: WALLET,
    inputMint: SOL_MINT,
    outputMint: TOKEN_MINT,
    amount: '1',
  });

  assert.equal(scope.isDone(), true);
});

test('getSwapQuote sends x-api-key header when JUPITER_API_KEY is set', async () => {
  process.env.JUPITER_API_KEY = 'secret-jup-key';
  _resetConfigForTests();

  const scope = nock('https://api.jup.ag', {
    reqheaders: { 'x-api-key': 'secret-jup-key' },
  })
    .get('/swap/v1/quote')
    .query(true)
    .reply(200, {
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      inAmount: '1',
      outAmount: '1',
      priceImpactPct: '0',
      routePlan: [],
    });

  await getSwapQuote({
    walletAddress: WALLET,
    inputMint: SOL_MINT,
    outputMint: TOKEN_MINT,
    amount: '1',
  });

  assert.equal(scope.isDone(), true);
});

test('getSwapQuote omits x-api-key header when JUPITER_API_KEY is unset', async () => {
  // nock's `badheaders` rejects matches that *include* the listed header.
  const scope = nock('https://api.jup.ag', {
    badheaders: ['x-api-key'],
  })
    .get('/swap/v1/quote')
    .query(true)
    .reply(200, {
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      inAmount: '1',
      outAmount: '1',
      priceImpactPct: '0',
      routePlan: [],
    });

  await getSwapQuote({
    walletAddress: WALLET,
    inputMint: SOL_MINT,
    outputMint: TOKEN_MINT,
    amount: '1',
  });

  assert.equal(scope.isDone(), true);
});

test('getSwapQuote throws on 4xx with informative message', async () => {
  nock('https://api.jup.ag')
    .get('/swap/v1/quote')
    .query(true)
    .reply(400, 'invalid mint');

  await assert.rejects(
    () =>
      getSwapQuote({
        walletAddress: WALLET,
        inputMint: SOL_MINT,
        outputMint: TOKEN_MINT,
        amount: '1',
      }),
    /Jupiter quote failed \(400\):.*invalid mint/,
  );
});

test('getSwapQuote throws on 5xx with informative message', async () => {
  nock('https://api.jup.ag')
    .get('/swap/v1/quote')
    .query(true)
    .reply(503, 'upstream unavailable');

  await assert.rejects(
    () =>
      getSwapQuote({
        walletAddress: WALLET,
        inputMint: SOL_MINT,
        outputMint: TOKEN_MINT,
        amount: '1',
      }),
    /Jupiter quote failed \(503\):.*upstream unavailable/,
  );
});

test('getSwapQuote rejects when priceImpactPct exceeds MAX_PRICE_IMPACT_PCT', async () => {
  // 50% impact, configured max 10% -> rejected.
  process.env.MAX_PRICE_IMPACT_PCT = '10';
  _resetConfigForTests();

  nock('https://api.jup.ag')
    .get('/swap/v1/quote')
    .query(true)
    .reply(200, {
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      inAmount: '1000000000',
      outAmount: '500000000',
      priceImpactPct: '0.50',
      routePlan: [],
    });

  await assert.rejects(
    () =>
      getSwapQuote({
        walletAddress: WALLET,
        inputMint: SOL_MINT,
        outputMint: TOKEN_MINT,
        amount: '1000000000',
      }),
    /Price impact 50\.00% exceeds configured max of 10%/,
  );
});

test('getSwapQuote accepts priceImpactPct within MAX_PRICE_IMPACT_PCT bound', async () => {
  // 5% impact, configured max 10% -> passes through.
  process.env.MAX_PRICE_IMPACT_PCT = '10';
  _resetConfigForTests();

  nock('https://api.jup.ag')
    .get('/swap/v1/quote')
    .query(true)
    .reply(200, {
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      inAmount: '1000000000',
      outAmount: '950000000',
      priceImpactPct: '0.05',
      routePlan: [],
    });

  const quote = await getSwapQuote({
    walletAddress: WALLET,
    inputMint: SOL_MINT,
    outputMint: TOKEN_MINT,
    amount: '1000000000',
  });
  assert.equal(quote.priceImpactPct, '0.05');
  assert.equal(quote.outAmount, '950000000');
});

test('getSwapQuote returns quote without rejection when priceImpactPct is missing', async () => {
  nock('https://api.jup.ag')
    .get('/swap/v1/quote')
    .query(true)
    .reply(200, {
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      inAmount: '1000000000',
      outAmount: '950000000',
      // priceImpactPct intentionally omitted
      routePlan: [],
    });

  const quote = await getSwapQuote({
    walletAddress: WALLET,
    inputMint: SOL_MINT,
    outputMint: TOKEN_MINT,
    amount: '1000000000',
  });
  assert.equal(quote.outAmount, '950000000');
  assert.equal(quote.priceImpactPct, undefined);
});

// ---------------------------------------------------------------------------
// getSwapTransaction
// ---------------------------------------------------------------------------

test('getSwapTransaction posts expected body and returns parsed swap response', async () => {
  const quoteResponse = {
    inputMint: SOL_MINT,
    outputMint: TOKEN_MINT,
    inAmount: '1000000000',
    outAmount: '950000000',
    priceImpactPct: '0.01',
    routePlan: [],
  };

  let capturedBody: unknown;
  let capturedContentType: string | undefined;
  const scope = nock('https://api.jup.ag')
    .post('/swap/v1/swap', (body) => {
      capturedBody = body;
      return true;
    })
    .matchHeader('content-type', (val) => {
      capturedContentType = Array.isArray(val) ? val[0] : val;
      return /application\/json/i.test(String(val));
    })
    .reply(200, {
      swapTransaction: 'base64tx==',
      lastValidBlockHeight: 12345,
    });

  const resp = await getSwapTransaction(WALLET, quoteResponse as never);

  assert.equal(resp.swapTransaction, 'base64tx==');
  assert.equal(resp.lastValidBlockHeight, 12345);
  assert.equal(scope.isDone(), true);

  // Body shape assertions
  const body = capturedBody as Record<string, unknown>;
  assert.deepEqual(body.quoteResponse, quoteResponse);
  assert.equal(body.userPublicKey, WALLET);
  assert.equal(body.wrapAndUnwrapSol, true);
  assert.equal(body.dynamicComputeUnitLimit, true);
  assert.ok(/application\/json/i.test(String(capturedContentType ?? '')));
});

test('getSwapTransaction sends x-api-key header when JUPITER_API_KEY is set', async () => {
  process.env.JUPITER_API_KEY = 'secret-jup-key';
  _resetConfigForTests();

  const scope = nock('https://api.jup.ag', {
    reqheaders: { 'x-api-key': 'secret-jup-key' },
  })
    .post('/swap/v1/swap')
    .reply(200, {
      swapTransaction: 'base64tx==',
      lastValidBlockHeight: 1,
    });

  await getSwapTransaction(WALLET, {
    inputMint: SOL_MINT,
    outputMint: TOKEN_MINT,
    inAmount: '1',
    outAmount: '1',
    priceImpactPct: '0',
    routePlan: [],
  } as never);

  assert.equal(scope.isDone(), true);
});

test('getSwapTransaction throws on 4xx with informative message', async () => {
  nock('https://api.jup.ag')
    .post('/swap/v1/swap')
    .reply(400, 'route unavailable');

  await assert.rejects(
    () =>
      getSwapTransaction(WALLET, {
        inputMint: SOL_MINT,
        outputMint: TOKEN_MINT,
        inAmount: '1',
        outAmount: '1',
        priceImpactPct: '0',
        routePlan: [],
      } as never),
    /Jupiter swap failed \(400\):.*route unavailable/,
  );
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

test('SOL_MINT constant matches the canonical wrapped SOL pubkey', () => {
  assert.equal(SOL_MINT, 'So11111111111111111111111111111111111111112');
});
