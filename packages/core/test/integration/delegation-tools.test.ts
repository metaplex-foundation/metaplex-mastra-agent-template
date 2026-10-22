import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import nacl from 'tweetnacl';
import { RequestContext } from '@mastra/core/request-context';
import { publicKey as umiPubkey, type Umi } from '@metaplex-foundation/umi';
import { base64 } from '@metaplex-foundation/umi/serializers';
import {
  findExecutionDelegateRecordV1Pda,
  findExecutiveProfileV1Pda,
  getExecutionDelegateRecordV1AccountDataSerializer,
  getExecutiveProfileV1AccountDataSerializer,
} from '@metaplex-foundation/mpl-agent-registry';
import { isolateEnv, restoreEnv, defaultTestEnv } from '../../../shared/test/helpers/env.js';
import { startMockRpc, blockhashFixture, type MockRpc } from '../../../shared/test/helpers/mock-rpc.js';
import { makeTestUmi } from '../../../shared/test/helpers/umi.js';
import { _resetConfigForTests } from '@metaplex-foundation/shared';
import { listDelegates } from '../../src/tools/list-delegates.js';
import { revokeDelegate } from '../../src/tools/revoke-delegate.js';
import { delegateToNori } from '../../src/tools/delegate-to-nori.js';

/**
 * Integration tests for the Nori delegation tools (`list-delegates`,
 * `revoke-delegate`, `delegate-to-nori`).
 *
 * Boundaries:
 *  - Solana JSON-RPC → in-process `startMockRpc()`; registry accounts are
 *    serialized with the registry's own serializers so the tools decode
 *    real bytes.
 *  - Plumber's agent card (`fetch`) → a stub on `globalThis.fetch` that
 *    only answers `PLUMBER_URL` (umi talks to the mock RPC via node-fetch,
 *    which is unaffected).
 *  - The user's wallet → a `transactionSender.sendAndAwait` stub that
 *    records the base64 tx and returns a canned signature.
 */

const PLUMBER_URL = 'https://plumber.test';
// Registry account discriminators (the `Key` enum is not re-exported).
const KEY_EXECUTIVE_PROFILE_V1 = 1;
const KEY_EXECUTION_DELEGATE_RECORD_V1 = 2;
const REGISTRY_PROGRAM = 'TLREGni9ZEyGC3vnPZtqUh95xQ8oPqJSvNjvB7FGK8S';
const AGENT_ASSET = 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2';
const AGENT_KEYPAIR = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));

function randomAddress(): string {
  return umiPubkey(nacl.sign.keyPair().publicKey).toString();
}

const PLUMBER_EXEC = randomAddress();
const OWNER_WALLET = randomAddress();
const OTHER_EXEC = randomAddress();

let rpc: MockRpc;
let umi: Umi;
let selfPk: string;
const realFetch = globalThis.fetch;
let cardFetches: string[] = [];
let cardResponder: () => Response | Promise<Response>;

interface SentTx {
  b64: string;
  opts: { message?: string };
}
let sent: SentTx[] = [];

function makeCtx(opts: { walletAddress?: string | null; withSender?: boolean } = {}): RequestContext {
  const entries: [string, unknown][] = [
    ['umi', umi],
    ['agentMode', 'public'],
    ['walletAddress', opts.walletAddress === undefined ? OWNER_WALLET : opts.walletAddress],
  ];
  if (opts.withSender !== false) {
    entries.push([
      'transactionSender',
      {
        sendAndAwait: async (b64: string, o: { message?: string }) => {
          sent.push({ b64, opts: o });
          return 'WALLET_SIG';
        },
      },
    ]);
  }
  return new RequestContext(entries);
}

function setEnv(extra: Record<string, string> = {}): void {
  isolateEnv(
    defaultTestEnv({
      AGENT_KEYPAIR,
      SOLANA_RPC_URL: rpc.url,
      ...extra,
    }),
  );
  _resetConfigForTests();
}

function accountInfo(data: Uint8Array) {
  return {
    data: [Buffer.from(data).toString('base64'), 'base64'],
    executable: false,
    lamports: 1_000_000,
    owner: REGISTRY_PROGRAM,
    rentEpoch: 0,
    space: data.length,
  };
}

function delegateRecordBytes(executiveProfile: string, authority: string): Uint8Array {
  return getExecutionDelegateRecordV1AccountDataSerializer().serialize({
    key: KEY_EXECUTION_DELEGATE_RECORD_V1,
    bump: 255,
    executiveProfile: umiPubkey(executiveProfile),
    authority: umiPubkey(authority),
    agentAsset: umiPubkey(AGENT_ASSET),
  });
}

function profilePda(authority: string): string {
  return findExecutiveProfileV1Pda(umi, { authority: umiPubkey(authority) })[0].toString();
}

function recordPda(authority: string): string {
  return findExecutionDelegateRecordV1Pda(umi, {
    executiveProfile: umiPubkey(profilePda(authority)),
    agentAsset: umiPubkey(AGENT_ASSET),
  })[0].toString();
}

/** Serve getAccountInfo from an address → bytes map; anything else is null. */
function serveAccounts(accounts: Record<string, Uint8Array>): void {
  rpc.on('getAccountInfo', (params) => {
    const addr = params[0] as string;
    const data = accounts[addr];
    return { context: { slot: 1 }, value: data ? accountInfo(data) : null };
  });
}

function decodeSentTx(b64: string) {
  const bytes = base64.serialize(b64);
  const tx = umi.transactions.deserialize(bytes);
  const keys = tx.message.accounts.map((k) => k.toString());
  const programs = tx.message.instructions.map((ix) => keys[ix.programIndex]);
  return { tx, keys, programs };
}

beforeEach(async () => {
  rpc = await startMockRpc();
  rpc.on('getLatestBlockhash', () => blockhashFixture());
  ({ umi, publicKey: selfPk } = makeTestUmi(rpc.url));
  cardFetches = [];
  sent = [];
  cardResponder = () =>
    new Response(JSON.stringify({ serviceExecutiveAddress: PLUMBER_EXEC }), {
      headers: { 'content-type': 'application/json' },
    });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
    if (url.startsWith(PLUMBER_URL)) {
      cardFetches.push(url);
      return cardResponder();
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await rpc.close();
  restoreEnv();
  _resetConfigForTests();
});

// ---------------------------------------------------------------------------
// list-delegates
// ---------------------------------------------------------------------------

describe('list-delegates', () => {
  test('errors when AGENT_ASSET_ADDRESS is not configured', async () => {
    setEnv();
    const result = (await listDelegates.execute!({}, { requestContext: makeCtx() } as any)) as any;
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'INVALID_INPUT');
    assert.match(result.message, /AGENT_ASSET_ADDRESS is not set/);
    assert.equal(rpc.calls.length, 0);
  });

  test('tags delegates as plumber / self / other using the agent card', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET, PLUMBER_URL: `${PLUMBER_URL}/` });
    const rows = [PLUMBER_EXEC, selfPk, OTHER_EXEC].map((authority) => ({
      pubkey: recordPda(authority),
      account: accountInfo(delegateRecordBytes(profilePda(authority), authority)),
    }));
    rpc.on('getProgramAccounts', () => rows);

    const result = (await listDelegates.execute!({}, { requestContext: makeCtx() } as any)) as any;
    assert.equal(result.status, 'success');
    assert.equal(result.agentAsset, AGENT_ASSET);
    assert.equal(result.plumberExecutive, PLUMBER_EXEC);
    assert.deepEqual(cardFetches, [`${PLUMBER_URL}/.well-known/agent-card.json`], 'trailing slash stripped');
    assert.deepEqual(
      result.delegates.map((d: any) => [d.authority, d.role]),
      [
        [PLUMBER_EXEC, 'plumber'],
        [selfPk, 'self'],
        [OTHER_EXEC, 'other'],
      ],
    );
    assert.equal(result.delegates[0].executiveProfile, profilePda(PLUMBER_EXEC));
    assert.equal(result.delegates[0].executionDelegateRecord, recordPda(PLUMBER_EXEC));
    assert.match(result.message, /^3 delegate\(s\) registered on /);

    // The GPA query is scoped to the registry program and filtered by agent asset.
    const gpa = rpc.calls.find((c) => c.method === 'getProgramAccounts')!;
    assert.equal(gpa.params[0], REGISTRY_PROGRAM);
    assert.ok(JSON.stringify(gpa.params[1]).includes(AGENT_ASSET));
  });

  test('without PLUMBER_URL nothing is fetched and no row is tagged plumber', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET });
    rpc.on('getProgramAccounts', () => [
      {
        pubkey: recordPda(PLUMBER_EXEC),
        account: accountInfo(delegateRecordBytes(profilePda(PLUMBER_EXEC), PLUMBER_EXEC)),
      },
    ]);
    const result = (await listDelegates.execute!({}, { requestContext: makeCtx() } as any)) as any;
    assert.equal(result.status, 'success');
    assert.equal(result.plumberExecutive, null);
    assert.equal(result.delegates[0].role, 'other');
    assert.equal(cardFetches.length, 0);
  });

  test('an unreachable plumber card degrades to plumberExecutive=null', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET, PLUMBER_URL });
    cardResponder = () => {
      throw new Error('ECONNREFUSED');
    };
    rpc.on('getProgramAccounts', () => []);
    const result = (await listDelegates.execute!({}, { requestContext: makeCtx() } as any)) as any;
    assert.equal(result.status, 'success');
    assert.equal(result.plumberExecutive, null);
    assert.deepEqual(result.delegates, []);
    assert.equal(result.message, `No execution delegates registered on ${AGENT_ASSET}.`);
  });

  test('a non-OK plumber card response leaves plumberExecutive=null', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET, PLUMBER_URL });
    cardResponder = () => new Response('down', { status: 503 });
    rpc.on('getProgramAccounts', () => []);
    const result = (await listDelegates.execute!({}, { requestContext: makeCtx() } as any)) as any;
    assert.equal(result.plumberExecutive, null);
  });

  test('a GPA failure surfaces as RPC_FAILURE', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET });
    rpc.on('getProgramAccounts', () => {
      throw new Error('gpa disabled on this node');
    });
    const result = (await listDelegates.execute!({}, { requestContext: makeCtx() } as any)) as any;
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'RPC_FAILURE');
    assert.match(result.message, /failed to fetch delegate records/);
  });
});

// ---------------------------------------------------------------------------
// revoke-delegate
// ---------------------------------------------------------------------------

describe('revoke-delegate', () => {
  test('input schema requires exactly one of target / delegateAuthority', () => {
    const schema = revokeDelegate.inputSchema as any;
    assert.equal(schema.safeParse({}).success, false);
    assert.equal(schema.safeParse({ target: 'nori', delegateAuthority: OTHER_EXEC }).success, false);
    assert.equal(schema.safeParse({ target: 'nori' }).success, true);
    assert.equal(schema.safeParse({ delegateAuthority: OTHER_EXEC }).success, true);
    assert.equal(schema.safeParse({ target: 'someone-else' }).success, false);
  });

  test('errors when AGENT_ASSET_ADDRESS is not configured', async () => {
    setEnv();
    const result = (await revokeDelegate.execute!(
      { delegateAuthority: OTHER_EXEC },
      { requestContext: makeCtx() } as any,
    )) as any;
    assert.equal(result.code, 'INVALID_INPUT');
    assert.match(result.message, /AGENT_ASSET_ADDRESS is not set/);
  });

  test('target=nori without PLUMBER_URL short-circuits before any network call', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET });
    const result = (await revokeDelegate.execute!(
      { target: 'nori' },
      { requestContext: makeCtx() } as any,
    )) as any;
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'INVALID_INPUT');
    assert.match(result.message, /PLUMBER_URL is not set — cannot resolve target=nori/);
    assert.equal(cardFetches.length, 0);
    assert.equal(rpc.calls.length, 0);
  });

  test('target=plumber with an unreachable card returns RPC_FAILURE', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET, PLUMBER_URL });
    cardResponder = () => new Response('', { status: 502 });
    const result = (await revokeDelegate.execute!(
      { target: 'plumber' },
      { requestContext: makeCtx() } as any,
    )) as any;
    assert.equal(result.code, 'RPC_FAILURE');
    assert.match(result.message, /HTTP 502/);
  });

  test('target=nori with a card lacking serviceExecutiveAddress returns RPC_FAILURE', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET, PLUMBER_URL });
    cardResponder = () => new Response('{}', { headers: { 'content-type': 'application/json' } });
    const result = (await revokeDelegate.execute!(
      { target: 'nori' },
      { requestContext: makeCtx() } as any,
    )) as any;
    assert.equal(result.code, 'RPC_FAILURE');
    assert.match(result.message, /missing serviceExecutiveAddress/);
  });

  test('target=nori with a network error returns RPC_FAILURE', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET, PLUMBER_URL });
    cardResponder = () => {
      throw new Error('socket hang up');
    };
    const result = (await revokeDelegate.execute!(
      { target: 'nori' },
      { requestContext: makeCtx() } as any,
    )) as any;
    assert.equal(result.code, 'RPC_FAILURE');
    assert.match(result.message, /failed to fetch plumber agent card: socket hang up/);
  });

  test('rejects a delegateAuthority that is not a valid pubkey', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET });
    const result = (await revokeDelegate.execute!(
      { delegateAuthority: 'definitely-not-base58!' },
      { requestContext: makeCtx() } as any,
    )) as any;
    assert.equal(result.code, 'INVALID_INPUT');
    assert.match(result.message, /not a valid base58 pubkey/);
  });

  test('is idempotent: no record on chain → ok without a wallet popup', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET });
    serveAccounts({});
    const result = (await revokeDelegate.execute!(
      { delegateAuthority: OTHER_EXEC },
      { requestContext: makeCtx() } as any,
    )) as any;
    assert.equal(result.status, 'success');
    assert.equal(result.revokedAuthority, OTHER_EXEC);
    assert.equal(result.signature, undefined);
    assert.match(result.message, /No active delegation found/);
    assert.equal(sent.length, 0);
    // It looked up exactly the delegate record PDA for this executive + asset.
    const lookups = rpc.calls.filter((c) => c.method === 'getAccountInfo').map((c) => c.params[0]);
    assert.deepEqual(lookups, [recordPda(OTHER_EXEC)]);
  });

  test('requires a connected wallet when a record exists', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET });
    serveAccounts({ [recordPda(OTHER_EXEC)]: delegateRecordBytes(profilePda(OTHER_EXEC), OTHER_EXEC) });
    const result = (await revokeDelegate.execute!(
      { delegateAuthority: OTHER_EXEC },
      { requestContext: makeCtx({ walletAddress: null }) } as any,
    )) as any;
    assert.equal(result.code, 'UNAUTHORIZED');
    assert.equal(sent.length, 0);
  });

  test('target=nori happy path: owner wallet signs a revoke tx for plumber', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET, PLUMBER_URL });
    serveAccounts({
      [recordPda(PLUMBER_EXEC)]: delegateRecordBytes(profilePda(PLUMBER_EXEC), PLUMBER_EXEC),
    });
    const result = (await revokeDelegate.execute!(
      { target: 'nori' },
      { requestContext: makeCtx() } as any,
    )) as any;
    assert.equal(result.status, 'success');
    assert.equal(result.signature, 'WALLET_SIG');
    assert.equal(result.revokedAuthority, PLUMBER_EXEC);
    assert.match(result.message, /fall back to x402/);

    assert.equal(sent.length, 1);
    assert.match(sent[0]!.opts.message!, new RegExp(`Revoke execution delegate ${PLUMBER_EXEC.slice(0, 8)}`));
    const { tx, keys, programs } = decodeSentTx(sent[0]!.b64);
    assert.deepEqual(programs, [REGISTRY_PROGRAM]);
    assert.equal(keys[0], OWNER_WALLET, 'owner wallet pays the fee');
    assert.ok(keys.includes(recordPda(PLUMBER_EXEC)));
    assert.ok(keys.includes(AGENT_ASSET));
    // Owner's slot is left for the wallet to fill.
    assert.ok(tx.signatures[0]!.every((b) => b === 0));
  });

  test('explicit delegateAuthority happy path omits the x402 fallback note', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET });
    serveAccounts({ [recordPda(OTHER_EXEC)]: delegateRecordBytes(profilePda(OTHER_EXEC), OTHER_EXEC) });
    const result = (await revokeDelegate.execute!(
      { delegateAuthority: OTHER_EXEC },
      { requestContext: makeCtx() } as any,
    )) as any;
    assert.equal(result.status, 'success');
    assert.equal(result.message, `Revoked delegate ${OTHER_EXEC} on ${AGENT_ASSET}.`);
  });

  test('a wallet/sender failure surfaces as GENERIC', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET });
    serveAccounts({ [recordPda(OTHER_EXEC)]: delegateRecordBytes(profilePda(OTHER_EXEC), OTHER_EXEC) });
    const result = (await revokeDelegate.execute!(
      { delegateAuthority: OTHER_EXEC },
      { requestContext: makeCtx({ withSender: false }) } as any,
    )) as any;
    assert.equal(result.code, 'GENERIC');
    assert.match(result.message, /revoke failed: No transaction sender available/);
  });
});

// ---------------------------------------------------------------------------
// delegate-to-nori
// ---------------------------------------------------------------------------

describe('delegate-to-nori', () => {
  test('PLUMBER_URL unset short-circuits before any network call', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET });
    const result = (await delegateToNori.execute!({}, { requestContext: makeCtx() } as any)) as any;
    assert.equal(result.code, 'INVALID_INPUT');
    assert.match(result.message, /PLUMBER_URL is not set/);
    assert.equal(cardFetches.length, 0);
    assert.equal(rpc.calls.length, 0);
  });

  test('AGENT_ASSET_ADDRESS unset short-circuits', async () => {
    setEnv({ PLUMBER_URL });
    const result = (await delegateToNori.execute!({}, { requestContext: makeCtx() } as any)) as any;
    assert.equal(result.code, 'INVALID_INPUT');
    assert.match(result.message, /AGENT_ASSET_ADDRESS is not set/);
    assert.equal(cardFetches.length, 0);
  });

  test('plumber card HTTP error → RPC_FAILURE', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET, PLUMBER_URL });
    cardResponder = () => new Response('', { status: 404 });
    const result = (await delegateToNori.execute!({}, { requestContext: makeCtx() } as any)) as any;
    assert.equal(result.code, 'RPC_FAILURE');
    assert.match(result.message, /plumber unreachable \(HTTP 404\)/);
  });

  test('plumber card without serviceExecutiveAddress → RPC_FAILURE', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET, PLUMBER_URL });
    cardResponder = () => new Response('{"name":"old"}');
    const result = (await delegateToNori.execute!({}, { requestContext: makeCtx() } as any)) as any;
    assert.equal(result.code, 'RPC_FAILURE');
    assert.match(result.message, /older plumber version/);
  });

  test('plumber card network error → RPC_FAILURE', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET, PLUMBER_URL });
    cardResponder = () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    const result = (await delegateToNori.execute!({}, { requestContext: makeCtx() } as any)) as any;
    assert.equal(result.code, 'RPC_FAILURE');
    assert.match(result.message, /ENOTFOUND/);
  });

  test('already delegated (plumber + self) → ok without a wallet popup', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET, PLUMBER_URL });
    serveAccounts({
      [recordPda(PLUMBER_EXEC)]: delegateRecordBytes(profilePda(PLUMBER_EXEC), PLUMBER_EXEC),
      [recordPda(selfPk)]: delegateRecordBytes(profilePda(selfPk), selfPk),
    });
    const result = (await delegateToNori.execute!({}, { requestContext: makeCtx() } as any)) as any;
    assert.equal(result.status, 'success');
    assert.equal(result.delegatedTo, PLUMBER_EXEC);
    assert.equal(result.signature, undefined);
    assert.match(result.message, /^Already delegated/);
    assert.equal(sent.length, 0);
  });

  test('requires a connected wallet when delegation is needed', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET, PLUMBER_URL });
    serveAccounts({});
    const result = (await delegateToNori.execute!(
      {},
      { requestContext: makeCtx({ walletAddress: null }) } as any,
    )) as any;
    assert.equal(result.code, 'UNAUTHORIZED');
    assert.equal(sent.length, 0);
  });

  test('fresh agent: registers the executive profile and both delegations in one tx', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET, PLUMBER_URL });
    serveAccounts({});
    const result = (await delegateToNori.execute!({}, { requestContext: makeCtx() } as any)) as any;
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(result.signature, 'WALLET_SIG');
    assert.equal(result.delegatedTo, PLUMBER_EXEC);
    assert.equal(result.agentAsset, AGENT_ASSET);

    assert.equal(sent.length, 1);
    const { tx, keys, programs } = decodeSentTx(sent[0]!.b64);
    assert.deepEqual(programs, [REGISTRY_PROGRAM, REGISTRY_PROGRAM, REGISTRY_PROGRAM]);
    assert.equal(keys[0], OWNER_WALLET, 'owner wallet is the fee payer');
    assert.ok(keys.includes(profilePda(selfPk)), 'self executive profile is initialized');
    assert.ok(keys.includes(recordPda(PLUMBER_EXEC)));
    assert.ok(keys.includes(recordPda(selfPk)));

    // The agent keypair pre-signs (registerExecutiveV1 authority); the
    // owner's slot is left empty for the wallet.
    const selfIdx = keys.indexOf(selfPk);
    assert.ok(selfIdx > 0 && selfIdx < tx.message.header.numRequiredSignatures);
    assert.ok(tx.signatures[selfIdx]!.some((b) => b !== 0));
    assert.ok(tx.signatures[0]!.every((b) => b === 0));
  });

  test('partially delegated: only the missing self delegation is added', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET, PLUMBER_URL });
    const profileBytes = getExecutiveProfileV1AccountDataSerializer().serialize({
      key: KEY_EXECUTIVE_PROFILE_V1,
      authority: umiPubkey(selfPk),
    });
    serveAccounts({
      [recordPda(PLUMBER_EXEC)]: delegateRecordBytes(profilePda(PLUMBER_EXEC), PLUMBER_EXEC),
      [profilePda(selfPk)]: profileBytes,
    });
    const result = (await delegateToNori.execute!({}, { requestContext: makeCtx() } as any)) as any;
    assert.equal(result.status, 'success', JSON.stringify(result));
    const { keys, programs } = decodeSentTx(sent[0]!.b64);
    assert.equal(programs.length, 1, 'only one delegateExecutionV1 ix');
    assert.ok(keys.includes(recordPda(selfPk)));
    assert.ok(!keys.includes(recordPda(PLUMBER_EXEC)));
  });

  test('a wallet rejection surfaces as GENERIC', async () => {
    setEnv({ AGENT_ASSET_ADDRESS: AGENT_ASSET, PLUMBER_URL });
    serveAccounts({});
    const ctx = makeCtx({ withSender: false });
    ctx.set('transactionSender', {
      sendAndAwait: async () => {
        throw new Error('User rejected the request');
      },
    });
    const result = (await delegateToNori.execute!({}, { requestContext: ctx } as any)) as any;
    assert.equal(result.code, 'GENERIC');
    assert.match(result.message, /delegation failed: User rejected the request/);
  });
});
