import { test, beforeEach, afterEach, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  Keypair as Web3Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Keypair as UmiKeypair } from '@metaplex-foundation/umi';
import {
  PlumberClient,
  plumberFetch,
  onPlumberPayment,
  setPlumberClient,
  getPlumberClient,
  initPlumberClient,
  deriveSourceAta,
  type PaymentRequirements,
  type PaymentRequired,
  type PlumberPaymentEvent,
} from '../../src/plumber-client.js';

/**
 * Tests for the plumber HTTP client (`src/plumber-client.ts`).
 *
 * `globalThis.fetch` is the network boundary: every test swaps it for a
 * scripted router that records calls and returns canned `Response`s, so no
 * real HTTP ever happens. Transactions are built fully offline (the client
 * makes no Solana RPC calls by design) and decoded with web3.js to assert on
 * their shape and signatures.
 */

const BASE_URL = 'https://plumber.test';
const AGENT_ASSET = 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2';
const FEE_PAYER = Web3Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
const PAY_TO = Web3Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey.toBase58();
const BLOCKHASH = bs58.encode(new Uint8Array(32).fill(9));
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const DEVNET_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

const web3Agent = Web3Keypair.fromSeed(new Uint8Array(32).fill(7));
const agentKeypair: UmiKeypair = {
  publicKey: web3Agent.publicKey.toBase58() as UmiKeypair['publicKey'],
  secretKey: web3Agent.secretKey,
};

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

let calls: RecordedCall[] = [];
let routes: Array<{ match: (c: RecordedCall) => boolean; handler: Handler }> = [];
const realFetch = globalThis.fetch;
const realWarn = console.warn;
const realLog = console.log;

function route(match: (c: RecordedCall) => boolean, handler: Handler): void {
  routes.push({ match, handler });
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function installFetchStub(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const r = routes.find((x) => x.match(call));
    if (!r) throw new Error(`unexpected fetch: ${call.method} ${url}`);
    return r.handler(call);
  }) as typeof globalThis.fetch;
}

/** Install the standard happy-path challenge + handshake routes. */
function routeHandshake(tokens: string[] = ['tok-1']): { handshakes: () => number } {
  let n = 0;
  route(
    (c) => c.url === `${BASE_URL}/auth/challenge`,
    () => json({ nonce: `nonce-${n}` }),
  );
  route(
    (c) => c.url === `${BASE_URL}/auth/handshake`,
    () => {
      const token = tokens[Math.min(n, tokens.length - 1)];
      n += 1;
      return json({ token });
    },
  );
  return { handshakes: () => n };
}

function makeRequirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: DEVNET_CAIP2,
    amount: '5000',
    asset: 'SOL',
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { feePayer: FEE_PAYER, blockhash: BLOCKHASH, memo: 'req-123' },
    ...overrides,
  };
}

function paymentRequired(req: PaymentRequirements): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: `${BASE_URL}/v1/chat/completions` },
    accepts: [req],
  };
}

function settleHeader(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

function collectEvents(): { events: PlumberPaymentEvent[]; off: () => void } {
  const events: PlumberPaymentEvent[] = [];
  const off = onPlumberPayment((ev) => events.push(ev));
  return { events, off };
}

beforeEach(() => {
  calls = [];
  routes = [];
  installFetchStub();
  console.warn = () => {};
  console.log = () => {};
  setPlumberClient(null);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.log = realLog;
  setPlumberClient(null);
});

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

describe('PlumberClient accessors', () => {
  test('baseUrl strips trailing slashes', () => {
    const c = new PlumberClient({ baseUrl: `${BASE_URL}///`, agentKeypair });
    assert.equal(c.baseUrl, BASE_URL);
  });

  test('authorityAddress is the base58 pubkey of the agent keypair', () => {
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
    assert.equal(c.authorityAddress, web3Agent.publicKey.toBase58());
  });

  test('agentAssetAddress reflects the option', () => {
    assert.equal(new PlumberClient({ baseUrl: BASE_URL, agentKeypair }).agentAssetAddress, undefined);
    assert.equal(
      new PlumberClient({ baseUrl: BASE_URL, agentKeypair, agentAssetAddress: AGENT_ASSET })
        .agentAssetAddress,
      AGENT_ASSET,
    );
  });
});

// ---------------------------------------------------------------------------
// Bearer handshake
// ---------------------------------------------------------------------------

describe('getBearer', () => {
  test('returns null without touching the network when no agentAssetAddress is set', async () => {
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
    assert.equal(await c.getBearer(), null);
    assert.equal(calls.length, 0);
  });

  test('performs a signed handshake and returns the token', async () => {
    routeHandshake(['bearer-abc']);
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair, agentAssetAddress: AGENT_ASSET });

    const token = await c.getBearer();
    assert.equal(token, 'bearer-abc');
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url, `${BASE_URL}/auth/challenge`);

    const post = calls[1]!;
    assert.equal(post.method, 'POST');
    assert.equal(post.headers.get('content-type'), 'application/json');
    const { handshake, signature } = JSON.parse(post.body!) as {
      handshake: Record<string, string>;
      signature: string;
    };
    assert.equal(handshake.pubkey, web3Agent.publicKey.toBase58());
    assert.equal(handshake.agentAsset, AGENT_ASSET);
    assert.equal(handshake.audience, BASE_URL);
    assert.equal(handshake.nonce, 'nonce-0');
    const ttl = Date.parse(handshake.expiresAt!) - Date.parse(handshake.issuedAt!);
    assert.ok(ttl > 0 && ttl <= 5 * 60_000, `handshake TTL ${ttl}ms must be within 5 min`);

    // Signature must verify over the canonical (sorted-key) JSON.
    const canonical = JSON.stringify(
      Object.fromEntries(Object.keys(handshake).sort().map((k) => [k, handshake[k]])),
    );
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(canonical),
      bs58.decode(signature),
      web3Agent.publicKey.toBytes(),
    );
    assert.ok(ok, 'handshake signature must verify against canonical JSON');
  });

  test('caches the bearer across calls', async () => {
    const hs = routeHandshake(['tok-cached']);
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair, agentAssetAddress: AGENT_ASSET });
    assert.equal(await c.getBearer(), 'tok-cached');
    assert.equal(await c.getBearer(), 'tok-cached');
    assert.equal(hs.handshakes(), 1);
    assert.equal(calls.length, 2);
  });

  test('dedupes concurrent handshakes into one in-flight request', async () => {
    const hs = routeHandshake(['tok-shared']);
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair, agentAssetAddress: AGENT_ASSET });
    const results = await Promise.all([c.getBearer(), c.getBearer(), c.getBearer()]);
    assert.deepEqual(results, ['tok-shared', 'tok-shared', 'tok-shared']);
    assert.equal(hs.handshakes(), 1);
    assert.equal(calls.filter((x) => x.url.endsWith('/auth/challenge')).length, 1);
  });

  test('invalidateBearer forces a fresh handshake', async () => {
    const hs = routeHandshake(['tok-1', 'tok-2']);
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair, agentAssetAddress: AGENT_ASSET });
    assert.equal(await c.getBearer(), 'tok-1');
    c.invalidateBearer();
    assert.equal(await c.getBearer(), 'tok-2');
    assert.equal(hs.handshakes(), 2);
  });

  test('re-handshakes when the cached bearer is within the 30s refresh window', async () => {
    const hs = routeHandshake(['tok-1', 'tok-2']);
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair, agentAssetAddress: AGENT_ASSET });
    const realNow = Date.now;
    try {
      const t0 = realNow();
      Date.now = () => t0;
      assert.equal(await c.getBearer(), 'tok-1');
      // 15 min TTL minus 20s → inside the 30s skew buffer.
      Date.now = () => t0 + 15 * 60_000 - 20_000;
      assert.equal(await c.getBearer(), 'tok-2');
    } finally {
      Date.now = realNow;
    }
    assert.equal(hs.handshakes(), 2);
  });

  test('falls back to null when /auth/challenge fails', async () => {
    route((c) => c.url.endsWith('/auth/challenge'), () => new Response('nope', { status: 503 }));
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair, agentAssetAddress: AGENT_ASSET });
    assert.equal(await c.getBearer(), null);
    assert.equal(calls.length, 1, 'must not proceed to /auth/handshake');
    assert.match(String(warnings[0]?.[1]), /\/auth\/challenge HTTP 503/);
  });

  test('falls back to null when the challenge carries no nonce', async () => {
    route((c) => c.url.endsWith('/auth/challenge'), () => json({}));
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair, agentAssetAddress: AGENT_ASSET });
    assert.equal(await c.getBearer(), null);
    assert.match(String(warnings[0]?.[1]), /missing nonce/);
  });

  test('surfaces the server error reason when the handshake is rejected', async () => {
    route((c) => c.url.endsWith('/auth/challenge'), () => json({ nonce: 'n' }));
    route(
      (c) => c.url.endsWith('/auth/handshake'),
      () => json({ error: 'not a delegate' }, { status: 403 }),
    );
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair, agentAssetAddress: AGENT_ASSET });
    assert.equal(await c.getBearer(), null);
    assert.match(String(warnings[0]?.[1]), /rejected: not a delegate/);
  });

  test('uses the HTTP status as the reason when the rejection body is not JSON', async () => {
    route((c) => c.url.endsWith('/auth/challenge'), () => json({ nonce: 'n' }));
    route((c) => c.url.endsWith('/auth/handshake'), () => new Response('boom', { status: 500 }));
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair, agentAssetAddress: AGENT_ASSET });
    assert.equal(await c.getBearer(), null);
    assert.match(String(warnings[0]?.[1]), /rejected: HTTP 500/);
  });

  test('falls back to null when the handshake response has no token', async () => {
    route((c) => c.url.endsWith('/auth/challenge'), () => json({ nonce: 'n' }));
    route((c) => c.url.endsWith('/auth/handshake'), () => json({}));
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair, agentAssetAddress: AGENT_ASSET });
    assert.equal(await c.getBearer(), null);
  });

  test('a failed handshake is retried on the next call (no negative caching)', async () => {
    let fail = true;
    route(
      (c) => c.url.endsWith('/auth/challenge'),
      () => (fail ? new Response('x', { status: 500 }) : json({ nonce: 'n' })),
    );
    route((c) => c.url.endsWith('/auth/handshake'), () => json({ token: 'late-token' }));
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair, agentAssetAddress: AGENT_ASSET });
    assert.equal(await c.getBearer(), null);
    fail = false;
    assert.equal(await c.getBearer(), 'late-token');
  });
});

// ---------------------------------------------------------------------------
// buildPaymentTransaction
// ---------------------------------------------------------------------------

describe('buildPaymentTransaction', () => {
  test('rejects requirements without extra.feePayer', async () => {
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
    await assert.rejects(
      c.buildPaymentTransaction(makeRequirement({ extra: { blockhash: BLOCKHASH } })),
      /extra\.feePayer is required/,
    );
  });

  test('rejects requirements without extra.blockhash', async () => {
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
    await assert.rejects(
      c.buildPaymentTransaction(makeRequirement({ extra: { feePayer: FEE_PAYER } })),
      /extra\.blockhash is required/,
    );
  });

  test('native SOL: partial-signed v0 tx with transfer + memo, fee payer left unsigned', async () => {
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
    const b64 = await c.buildPaymentTransaction(makeRequirement());
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
    const msg = tx.message;
    const keys = msg.staticAccountKeys.map((k) => k.toBase58());

    assert.equal(keys[0], FEE_PAYER, 'plumber is the fee payer');
    assert.equal(msg.recentBlockhash, BLOCKHASH);
    assert.equal(msg.header.numRequiredSignatures, 2);
    // Fee payer slot is empty; our slot carries a valid signature.
    assert.ok(tx.signatures[0]!.every((b) => b === 0));
    const ourIdx = keys.indexOf(web3Agent.publicKey.toBase58());
    assert.ok(ourIdx > 0);
    assert.ok(
      nacl.sign.detached.verify(msg.serialize(), tx.signatures[ourIdx]!, web3Agent.publicKey.toBytes()),
    );

    const programs = msg.compiledInstructions.map((ix) => keys[ix.programIdIndex]);
    assert.deepEqual(programs, [
      SystemProgram.programId.toBase58(),
      'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    ]);
    const transfer = msg.compiledInstructions[0]!;
    // SystemProgram transfer: u32 index (2) + u64 lamports LE.
    const data = Buffer.from(transfer.data);
    assert.equal(data.readUInt32LE(0), 2);
    assert.equal(data.readBigUInt64LE(4), 5000n);
    assert.equal(keys[transfer.accountKeyIndexes[1]!], PAY_TO);
    assert.equal(Buffer.from(msg.compiledInstructions[1]!.data).toString('utf8'), 'req-123');
  });

  test('omits the memo instruction when none is requested', async () => {
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
    const b64 = await c.buildPaymentTransaction(
      makeRequirement({ extra: { feePayer: FEE_PAYER, blockhash: BLOCKHASH } }),
    );
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
    assert.equal(tx.message.compiledInstructions.length, 1);
  });

  test('SPL asset: TransferChecked between the derived ATAs with the requested decimals', async () => {
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
    const b64 = await c.buildPaymentTransaction(
      makeRequirement({
        asset: USDC_MINT,
        amount: '1234567',
        extra: { feePayer: FEE_PAYER, blockhash: BLOCKHASH, asset_decimals: 9 },
      }),
    );
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    const ix = tx.message.compiledInstructions[0]!;
    assert.equal(keys[ix.programIdIndex], 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    const mint = new PublicKey(USDC_MINT);
    const sourceAta = getAssociatedTokenAddressSync(mint, web3Agent.publicKey).toBase58();
    const destAta = getAssociatedTokenAddressSync(mint, new PublicKey(PAY_TO), true).toBase58();
    const [src, m, dst, auth] = ix.accountKeyIndexes.map((i) => keys[i]);
    assert.equal(src, sourceAta);
    assert.equal(m, USDC_MINT);
    assert.equal(dst, destAta);
    assert.equal(auth, web3Agent.publicKey.toBase58());

    // TransferChecked layout: u8 tag (12) + u64 amount + u8 decimals.
    const data = Buffer.from(ix.data);
    assert.equal(data[0], 12);
    assert.equal(data.readBigUInt64LE(1), 1234567n);
    assert.equal(data[9], 9);
  });

  test('SPL asset defaults to 6 decimals', async () => {
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
    const b64 = await c.buildPaymentTransaction(
      makeRequirement({ asset: USDC_MINT, extra: { feePayer: FEE_PAYER, blockhash: BLOCKHASH } }),
    );
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
    assert.equal(Buffer.from(tx.message.compiledInstructions[0]!.data)[9], 6);
  });

  test('pda source: rejects SPL assets', async () => {
    const c = new PlumberClient({
      baseUrl: BASE_URL,
      agentKeypair,
      paymentSource: 'pda',
      agentAssetAddress: AGENT_ASSET,
    });
    await assert.rejects(
      c.buildPaymentTransaction(makeRequirement({ asset: USDC_MINT })),
      /only support native SOL/,
    );
  });

  test('pda source: requires agentAssetAddress', async () => {
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair, paymentSource: 'pda' });
    await assert.rejects(c.buildPaymentTransaction(makeRequirement()), /requires agentAssetAddress/);
  });

  test('pda source: builds an Execute-CPI tx signed by the executive, fee payer unsigned', async () => {
    const c = new PlumberClient({
      baseUrl: BASE_URL,
      agentKeypair,
      paymentSource: 'pda',
      agentAssetAddress: AGENT_ASSET,
    });
    const b64 = await c.buildPaymentTransaction(makeRequirement());
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    assert.equal(keys[0], FEE_PAYER);
    assert.equal(tx.message.recentBlockhash, BLOCKHASH);
    assert.ok(keys.includes(AGENT_ASSET), 'asset account is referenced by Execute');
    assert.ok(keys.includes(PAY_TO));
    const programs = tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]);
    assert.ok(programs.includes('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'), 'mpl-core Execute');
    assert.ok(programs.includes('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), 'memo');

    const ourIdx = keys.indexOf(web3Agent.publicKey.toBase58());
    assert.ok(ourIdx > 0);
    assert.ok(tx.signatures[0]!.every((b) => b === 0), 'fee payer slot left for plumber');
    assert.ok(
      nacl.sign.detached.verify(
        tx.message.serialize(),
        tx.signatures[ourIdx]!,
        web3Agent.publicKey.toBytes(),
      ),
    );
  });

  test('pda source without memo has no memo instruction', async () => {
    const c = new PlumberClient({
      baseUrl: BASE_URL,
      agentKeypair,
      paymentSource: 'pda',
      agentAssetAddress: AGENT_ASSET,
    });
    const b64 = await c.buildPaymentTransaction(
      makeRequirement({ extra: { feePayer: FEE_PAYER, blockhash: BLOCKHASH } }),
    );
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    const programs = tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]);
    assert.ok(!programs.includes('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'));
  });
});

// ---------------------------------------------------------------------------
// plumberFetch
// ---------------------------------------------------------------------------

describe('plumberFetch', () => {
  const CHAT_URL = `${BASE_URL}/v1/chat/completions`;

  test('passes non-402 responses through unchanged, without auth when no asset is set', async () => {
    route((c) => c.url === CHAT_URL, () => json({ ok: true }));
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
    const res = await plumberFetch(c)(CHAT_URL, {
      method: 'POST',
      headers: { 'x-custom': '1' },
      body: '{"q":1}',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.headers.get('authorization'), null);
    assert.equal(calls[0]!.headers.get('x-custom'), '1');
    assert.equal(calls[0]!.body, '{"q":1}');
    assert.equal(calls[0]!.method, 'POST');
  });

  test('attaches the bearer from the handshake to the request', async () => {
    routeHandshake(['tok-A']);
    route((c) => c.url === CHAT_URL, () => json({ ok: true }));
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair, agentAssetAddress: AGENT_ASSET });
    const res = await plumberFetch(c)(CHAT_URL, { method: 'POST', body: '{}' });
    assert.equal(res.status, 200);
    const req = calls.find((x) => x.url === CHAT_URL)!;
    assert.equal(req.headers.get('authorization'), 'Bearer tok-A');
  });

  test('on 401 with a bearer, re-handshakes and retries exactly once', async () => {
    const hs = routeHandshake(['stale', 'fresh']);
    route(
      (c) => c.url === CHAT_URL,
      (c) =>
        c.headers.get('authorization') === 'Bearer fresh'
          ? json({ ok: true })
          : new Response('unauthorized', { status: 401 }),
    );
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair, agentAssetAddress: AGENT_ASSET });
    const res = await plumberFetch(c)(CHAT_URL, { method: 'POST', body: '{"a":1}' });
    assert.equal(res.status, 200);
    assert.equal(hs.handshakes(), 2);
    const reqs = calls.filter((x) => x.url === CHAT_URL);
    assert.deepEqual(
      reqs.map((r) => r.headers.get('authorization')),
      ['Bearer stale', 'Bearer fresh'],
    );
    assert.equal(reqs[1]!.body, '{"a":1}', 'body is replayed on retry');
  });

  test('a second 401 is surfaced to the caller without further retries', async () => {
    routeHandshake(['t1', 't2']);
    route((c) => c.url === CHAT_URL, () => new Response('no', { status: 401 }));
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair, agentAssetAddress: AGENT_ASSET });
    const res = await plumberFetch(c)(CHAT_URL);
    assert.equal(res.status, 401);
    assert.equal(calls.filter((x) => x.url === CHAT_URL).length, 2);
  });

  test('401 without a bearer is not retried', async () => {
    route((c) => c.url === CHAT_URL, () => new Response('no', { status: 401 }));
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
    const res = await plumberFetch(c)(CHAT_URL);
    assert.equal(res.status, 401);
    assert.equal(calls.length, 1);
  });

  test('402: pays with X-PAYMENT, retries, and emits an x402-paid event', async () => {
    const req = makeRequirement();
    route(
      (c) => c.url === CHAT_URL,
      (c) => {
        const pay = c.headers.get('x-payment');
        if (!pay) return json(paymentRequired(req), { status: 402 });
        return json(
          { ok: 'paid' },
          {
            headers: {
              'x-payment-response': settleHeader({
                success: true,
                transaction: 'SETTLE_SIG',
                payer: 'PAYER_ADDR',
                network: DEVNET_CAIP2,
              }),
            },
          },
        );
      },
    );
    const { events, off } = collectEvents();
    try {
      const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
      const res = await plumberFetch(c)(CHAT_URL, { method: 'POST', body: '{"m":1}' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: 'paid' });

      const [first, retry] = calls;
      assert.equal(first!.headers.get('x-payment'), null);
      assert.equal(retry!.body, '{"m":1}');
      const payload = JSON.parse(
        Buffer.from(retry!.headers.get('x-payment')!, 'base64').toString('utf8'),
      );
      assert.equal(payload.x402Version, 2);
      assert.deepEqual(payload.accepted, req);
      const tx = VersionedTransaction.deserialize(
        Buffer.from(payload.payload.transaction, 'base64'),
      );
      assert.equal(tx.message.staticAccountKeys[0]!.toBase58(), FEE_PAYER);

      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.kind, 'x402-paid');
      assert.equal(ev.purpose, 'inference');
      assert.equal(ev.label, 'x402 /v1/chat/completions');
      assert.equal(ev.from, 'PAYER_ADDR');
      assert.equal(ev.to, PAY_TO);
      assert.equal(ev.amount, '5000');
      assert.equal(ev.unit, 'lamports');
      assert.equal(ev.signature, 'SETTLE_SIG');
      assert.equal(ev.cluster, 'devnet');
      assert.equal(ev.detail?.memo, 'req-123');
      assert.equal(ev.detail?.endpoint, CHAT_URL);
      assert.ok(!Number.isNaN(Date.parse(ev.ts)));
    } finally {
      off();
    }
  });

  test('402 settled on mainnet for an SPL asset labels unit by mint and purpose rpc', async () => {
    const RPC_URL = `${BASE_URL}/v1/solana/rpc`;
    const req = makeRequirement({
      asset: USDC_MINT,
      network: MAINNET_CAIP2,
      extra: { feePayer: FEE_PAYER, blockhash: BLOCKHASH },
    });
    route(
      (c) => c.url === RPC_URL,
      (c) =>
        c.headers.get('x-payment')
          ? json(
              { result: 1 },
              {
                headers: {
                  'x-payment-response': settleHeader({
                    success: true,
                    transaction: 'SIG2',
                    network: MAINNET_CAIP2,
                  }),
                },
              },
            )
          : json(paymentRequired(req), { status: 402 }),
    );
    const { events, off } = collectEvents();
    try {
      const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
      const res = await plumberFetch(c)(new URL(RPC_URL), { method: 'POST', body: '{}' });
      assert.equal(res.status, 200);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.purpose, 'rpc');
      assert.equal(events[0]!.unit, USDC_MINT);
      assert.equal(events[0]!.cluster, 'mainnet-beta');
      assert.equal(events[0]!.from, null);
    } finally {
      off();
    }
  });

  test('402 with an unknown network and image endpoint via Request input', async () => {
    const IMG_URL = `${BASE_URL}/v1/images/generations`;
    const req = makeRequirement({ network: 'solana:unknown' });
    route(
      (c) => c.url === IMG_URL,
      (c) =>
        c.headers.get('x-payment')
          ? json(
              {},
              {
                headers: {
                  'x-payment-response': settleHeader({
                    success: true,
                    transaction: 'S',
                    network: 'solana:unknown',
                  }),
                },
              },
            )
          : json(paymentRequired(req), { status: 402 }),
    );
    const { events, off } = collectEvents();
    try {
      const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
      await plumberFetch(c)(new Request(IMG_URL), {});
      assert.equal(events[0]!.purpose, 'inference');
      assert.equal(events[0]!.cluster, null);
    } finally {
      off();
    }
  });

  test('402 retry rejected with an error status emits x402-rejected', async () => {
    const OTHER_URL = `${BASE_URL}/v1/other`;
    const req = makeRequirement();
    route(
      (c) => c.url === OTHER_URL,
      (c) =>
        c.headers.get('x-payment')
          ? new Response('bad payment', { status: 400 })
          : json(paymentRequired(req), { status: 402 }),
    );
    const { events, off } = collectEvents();
    try {
      const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
      const res = await plumberFetch(c)(OTHER_URL);
      assert.equal(res.status, 400);
      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.kind, 'x402-rejected');
      assert.equal(ev.purpose, 'other');
      assert.equal(ev.label, 'x402 retry rejected (HTTP 400)');
      assert.equal(ev.to, PAY_TO);
      assert.deepEqual(ev.detail, { endpoint: OTHER_URL, status: 400 });
    } finally {
      off();
    }
  });

  test('402 retry succeeding without a settlement header emits nothing', async () => {
    const req = makeRequirement();
    route(
      (c) => c.url === CHAT_URL,
      (c) => (c.headers.get('x-payment') ? json({ ok: 1 }) : json(paymentRequired(req), { status: 402 })),
    );
    const { events, off } = collectEvents();
    try {
      const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
      const res = await plumberFetch(c)(CHAT_URL);
      assert.equal(res.status, 200);
      assert.equal(events.length, 0);
    } finally {
      off();
    }
  });

  test('402 with a malformed settlement header still returns the response', async () => {
    const req = makeRequirement();
    route(
      (c) => c.url === CHAT_URL,
      (c) =>
        c.headers.get('x-payment')
          ? json({ ok: 1 }, { headers: { 'x-payment-response': 'not-base64-json' } })
          : json(paymentRequired(req), { status: 402 }),
    );
    const { events, off } = collectEvents();
    try {
      const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
      const res = await plumberFetch(c)(CHAT_URL);
      assert.equal(res.status, 200);
      assert.equal(events.length, 0);
    } finally {
      off();
    }
  });

  test('402 with a non-JSON body is returned as-is, no retry', async () => {
    route((c) => c.url === CHAT_URL, () => new Response('pay me', { status: 402 }));
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
    const res = await plumberFetch(c)(CHAT_URL);
    assert.equal(res.status, 402);
    assert.equal(await res.text(), 'pay me', 'original body is still readable');
    assert.equal(calls.length, 1);
  });

  for (const [name, body] of [
    ['wrong x402Version', { x402Version: 1, accepts: [makeRequirement()] }],
    ['missing accepts', { x402Version: 2 }],
    ['empty accepts', { x402Version: 2, accepts: [] }],
  ] as const) {
    test(`402 with ${name} is returned as-is, no retry`, async () => {
      route((c) => c.url === CHAT_URL, () => json(body, { status: 402 }));
      const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
      const res = await plumberFetch(c)(CHAT_URL);
      assert.equal(res.status, 402);
      assert.equal(calls.length, 1);
    });
  }

  test('402 whose requirement cannot be built rejects the fetch', async () => {
    route(
      (c) => c.url === CHAT_URL,
      () => json(paymentRequired(makeRequirement({ extra: {} })), { status: 402 }),
    );
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
    await assert.rejects(plumberFetch(c)(CHAT_URL), /feePayer is required/);
  });

  test('delegate-pay charge header emits a delegate-charge event', async () => {
    routeHandshake(['tok']);
    route(
      (c) => c.url === CHAT_URL,
      () =>
        json(
          { ok: true },
          {
            headers: {
              'x-plumber-charge-signature': 'CHARGE_SIG',
              'x-plumber-charge-rail': 'delegate',
            },
          },
        ),
    );
    const { events, off } = collectEvents();
    try {
      const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair, agentAssetAddress: AGENT_ASSET });
      const res = await plumberFetch(c)(CHAT_URL);
      assert.equal(res.status, 200);
      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.kind, 'delegate-charge');
      assert.equal(ev.purpose, 'inference');
      assert.equal(ev.label, 'delegate-pay /v1/chat/completions');
      assert.equal(ev.from, `PDA(${AGENT_ASSET.slice(0, 6)}…)`);
      assert.equal(ev.to, null);
      assert.equal(ev.signature, 'CHARGE_SIG');
      assert.deepEqual(ev.detail, { endpoint: CHAT_URL, rail: 'delegate' });
    } finally {
      off();
    }
  });

  test('delegate-charge without an asset address and with a relative URL', async () => {
    route(
      (c) => c.url === 'relative/path',
      () => json({}, { headers: { 'x-plumber-charge-signature': 'S' } }),
    );
    const { events, off } = collectEvents();
    try {
      const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
      await plumberFetch(c)('relative/path');
      assert.equal(events[0]!.from, null);
      // Unparseable URLs fall back to the raw string as the label.
      assert.equal(events[0]!.label, 'delegate-pay relative/path');
      assert.equal(events[0]!.purpose, 'other');
      assert.equal(events[0]!.detail?.rail, null);
    } finally {
      off();
    }
  });
});

// ---------------------------------------------------------------------------
// Payment event emitter
// ---------------------------------------------------------------------------

describe('onPlumberPayment', () => {
  test('unsubscribe stops delivery', async () => {
    route(
      (c) => c.url.endsWith('/x'),
      () => json({}, { headers: { 'x-plumber-charge-signature': 'S' } }),
    );
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
    const fetcher = plumberFetch(c);
    const seen: PlumberPaymentEvent[] = [];
    const off = onPlumberPayment((ev) => seen.push(ev));
    await fetcher(`${BASE_URL}/x`);
    off();
    await fetcher(`${BASE_URL}/x`);
    assert.equal(seen.length, 1);
  });

  test('a throwing listener does not break the request', async () => {
    route(
      (c) => c.url.endsWith('/x'),
      () => json({ fine: true }, { headers: { 'x-plumber-charge-signature': 'S' } }),
    );
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    const off = onPlumberPayment(() => {
      throw new Error('listener boom');
    });
    try {
      const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
      const res = await plumberFetch(c)(`${BASE_URL}/x`);
      assert.deepEqual(await res.json(), { fine: true });
      assert.match(String(warnings[0]?.[0]), /payment-event listener threw/);
    } finally {
      off();
    }
  });
});

// ---------------------------------------------------------------------------
// Singleton + diagnostics
// ---------------------------------------------------------------------------

describe('singleton accessors', () => {
  test('get returns null until set; set(null) clears', () => {
    assert.equal(getPlumberClient(), null);
    const c = new PlumberClient({ baseUrl: BASE_URL, agentKeypair });
    setPlumberClient(c);
    assert.equal(getPlumberClient(), c);
    setPlumberClient(null);
    assert.equal(getPlumberClient(), null);
  });

  test('initPlumberClient creates once and returns the existing instance afterwards', () => {
    const first = initPlumberClient({ baseUrl: BASE_URL, agentKeypair });
    assert.ok(first instanceof PlumberClient);
    assert.equal(getPlumberClient(), first);
    const second = initPlumberClient({ baseUrl: 'https://other.test', agentKeypair });
    assert.equal(second, first);
    assert.equal(second.baseUrl, BASE_URL);
  });
});

describe('deriveSourceAta', () => {
  test('matches the canonical associated token address', () => {
    const owner = web3Agent.publicKey.toBase58();
    const expected = getAssociatedTokenAddressSync(
      new PublicKey(USDC_MINT),
      web3Agent.publicKey,
    ).toBase58();
    assert.equal(deriveSourceAta({ keypairPubkey: owner, mint: USDC_MINT }), expected);
  });

  test('rejects invalid pubkeys', () => {
    assert.throws(() => deriveSourceAta({ keypairPubkey: 'not-a-key', mint: USDC_MINT }));
  });
});
