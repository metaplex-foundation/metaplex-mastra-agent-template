import { test, before, after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { transferSol } from '@metaplex-foundation/mpl-toolbox';
import { publicKey as toPublicKey, sol } from '@metaplex-foundation/umi';
import { startMockRpc, blockhashFixture, type MockRpc } from '../helpers/mock-rpc.js';
import { makeTestUmi, stubUmiRpc } from '../helpers/umi.js';
import { _resetConfigForTests } from '../../src/config.js';
import { submitOrSend, isDryRunSignature } from '../../src/transaction.js';
import { getAgentPda } from '../../src/execute.js';

/**
 * Tests for `getAgentPda` (in `src/execute.ts`) plus the Core Execute
 * routing behavior of `submitOrSend` / `submitAsAgent` (in
 * `src/transaction.ts`).
 *
 * Both files participate in the same load-bearing path: every on-chain
 * action the agent takes flows through `submitOrSend` (or its sister
 * helpers), and `getAgentPda` is how we surface the agent's PDA wallet
 * to tools that need to reference it.
 *
 * Config singleton caveats: `src/config.ts` memoizes `_config` at module
 * scope. ESM URL busters don't propagate through static `import` chains
 * (a `transaction.js?bust=X` still binds to the unbusted `config.js`),
 * so we use the test-only `_resetConfigForTests()` hook to drop the
 * cached singleton between tests instead.
 *
 * Test-file isolation: `node --test` spawns each *.test.ts in its own
 * worker process (Node >= 20), so env mutations here don't bleed into
 * sibling test files.
 */

// Use a real base58 32-byte pubkey for asset address fixtures. The
// SystemProgram ID is valid base58 and decodes to 32 bytes; works fine
// as a stand-in for "any asset" in PDA derivation tests.
const FIXTURE_ASSET = '11111111111111111111111111111112';
// A real-looking 32-byte base58 wallet for BOOTSTRAP_WALLET in autonomous
// mode (config validation rejects placeholders).
const FIXTURE_WALLET = 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2';

const ENV_SNAPSHOT: Record<string, string | undefined> = {};
let rpc: MockRpc;

before(async () => {
  for (const k of Object.keys(process.env)) ENV_SNAPSHOT[k] = process.env[k];
  rpc = await startMockRpc();
  // Register a blockhash handler in case any code path slips through the
  // umi.rpc stubs and goes over HTTP.
  rpc.on('getLatestBlockhash', () => blockhashFixture());
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v !== undefined) process.env[k] = v;
  }
  // Bust the config singleton so the next test re-reads env from scratch.
  _resetConfigForTests();
});

after(async () => {
  await rpc.close();
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v !== undefined) process.env[k] = v;
  }
});

const ZERO_KEYPAIR = '[' + Array.from({ length: 64 }, () => 0).join(',') + ']';

// ---------------------------------------------------------------------------
// 1. getAgentPda — pure sync PDA derivation
// ---------------------------------------------------------------------------

test('getAgentPda returns a valid base58 PDA distinct from the asset address', async () => {
  Object.assign(process.env, {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    SOLANA_RPC_URL: rpc.url,
    ANTHROPIC_API_KEY: 'test',
  });
  const { umi } = makeTestUmi(rpc.url);
  const pda = getAgentPda(umi, toPublicKey(FIXTURE_ASSET));
  const pdaStr = pda.toString();
  // 32-44 char base58 string (standard Solana address shape).
  assert.match(pdaStr, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  // PDA is derived from the asset seed — it must NOT equal the asset.
  assert.notEqual(pdaStr, FIXTURE_ASSET);
});

test('getAgentPda is deterministic for a given asset address', async () => {
  Object.assign(process.env, {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    SOLANA_RPC_URL: rpc.url,
    ANTHROPIC_API_KEY: 'test',
  });
  const { umi } = makeTestUmi(rpc.url);
  const a = getAgentPda(umi, toPublicKey(FIXTURE_ASSET)).toString();
  const b = getAgentPda(umi, toPublicKey(FIXTURE_ASSET)).toString();
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// 2. submitOrSend — public mode routes via transactionSender, no RPC send
// ---------------------------------------------------------------------------

test('submitOrSend in public mode serializes tx, calls transactionSender.sendAndAwait, never hits rpc.sendTransaction', async () => {
  Object.assign(process.env, {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    SOLANA_RPC_URL: rpc.url,
    ANTHROPIC_API_KEY: 'test',
  });
  const { umi, publicKey } = makeTestUmi(rpc.url);
  const rpcCalls = stubUmiRpc(umi);

  const senderCalls: { txBase64: string; options: any }[] = [];
  const fakeSig = 'sig-from-user-wallet';
  const transactionSender = {
    sendAndAwait: async (txBase64: string, options: any) => {
      senderCalls.push({ txBase64, options });
      return fakeSig;
    },
  };

  // transferSol from the wallet to an arbitrary destination. The wallet
  // signer is wired up by submitOrSend (NoopSigner over walletAddress)
  // so we can use any address as `source` here.
  const dest = toPublicKey('11111111111111111111111111111113');
  const builder = transferSol(umi, {
    source: umi.identity,
    destination: dest,
    amount: sol(0.01),
  });

  const sig = await submitOrSend(umi, builder, {
    walletAddress: publicKey,
    transactionSender,
    agentMode: 'public',
    agentAssetAddress: null,
    agentTokenMint: null,
    agentFeeSol: 0,
    tokenOverride: null,
    ownerWallet: null,
    txCounter: null,
  });

  assert.equal(sig, fakeSig);
  assert.equal(senderCalls.length, 1, 'transactionSender invoked exactly once');
  assert.ok(senderCalls[0].txBase64.length > 0, 'serialized tx is non-empty');
  // No HTTP-level sendTransaction call either.
  assert.equal(
    rpc.calls.filter((c) => c.method === 'sendTransaction').length,
    0,
    'public mode must not broadcast directly via RPC',
  );
  // And the in-umi stub also stays clean.
  assert.equal(rpcCalls.sendTransaction, 0);
  assert.equal(rpcCalls.confirmTransaction, 0);
});

test('submitOrSend in public mode throws when transactionSender is missing', async () => {
  Object.assign(process.env, {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    SOLANA_RPC_URL: rpc.url,
    ANTHROPIC_API_KEY: 'test',
  });
  const { umi, publicKey } = makeTestUmi(rpc.url);
  stubUmiRpc(umi);

  const builder = transferSol(umi, {
    source: umi.identity,
    destination: toPublicKey('11111111111111111111111111111113'),
    amount: sol(0.01),
  });

  await assert.rejects(
    submitOrSend(umi, builder, {
      walletAddress: publicKey,
      transactionSender: null,
      agentMode: 'public',
      agentAssetAddress: null,
      agentTokenMint: null,
      agentFeeSol: 0,
      tokenOverride: null,
      ownerWallet: null,
      txCounter: null,
    }),
    /transaction sender/i,
  );
});

// ---------------------------------------------------------------------------
// 3. submitOrSend — autonomous mode signs and submits via rpc.sendTransaction
// ---------------------------------------------------------------------------

test('submitOrSend in autonomous mode calls rpc.sendTransaction and rpc.confirmTransaction, returns base58 signature', async () => {
  Object.assign(process.env, {
    AGENT_MODE: 'autonomous',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    BOOTSTRAP_WALLET: FIXTURE_WALLET,
    SOLANA_RPC_URL: rpc.url,
    ANTHROPIC_API_KEY: 'test',
    // Crucial: dry-run defaults to true in autonomous mode. Flip it off
    // for the "actually submit" path test.
    AUTONOMOUS_DRY_RUN: 'false',
  });
  const { umi } = makeTestUmi(rpc.url);
  const rpcCalls = stubUmiRpc(umi);

  const builder = transferSol(umi, {
    source: umi.identity,
    destination: toPublicKey('11111111111111111111111111111113'),
    amount: sol(0.01),
  });

  const sig = await submitOrSend(umi, builder, {
    walletAddress: null,
    transactionSender: null,
    agentMode: 'autonomous',
    agentAssetAddress: null,
    agentTokenMint: null,
    agentFeeSol: 0,
    tokenOverride: null,
    ownerWallet: null,
    txCounter: null,
  });

  // base58 signature: 64-byte payload (all 1s) — non-empty string, no DRYRUN_ prefix.
  assert.ok(sig.length > 0);
  assert.ok(!sig.startsWith('DRYRUN_'), 'autonomous non-dry-run must not return a dry-run sig');
  assert.equal(rpcCalls.sendTransaction, 1, 'sendTransaction called exactly once');
  assert.equal(rpcCalls.confirmTransaction, 1, 'confirmTransaction called exactly once');
});

// ---------------------------------------------------------------------------
// 4. submitOrSend — autonomous + dry-run returns synthetic DRYRUN_ sig
// ---------------------------------------------------------------------------

test('submitOrSend in autonomous + dry-run returns a DRYRUN_ synthetic signature without broadcasting', async () => {
  Object.assign(process.env, {
    AGENT_MODE: 'autonomous',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    BOOTSTRAP_WALLET: FIXTURE_WALLET,
    SOLANA_RPC_URL: rpc.url,
    ANTHROPIC_API_KEY: 'test',
    AUTONOMOUS_DRY_RUN: 'true',
  });
  const { umi } = makeTestUmi(rpc.url);
  const rpcCalls = stubUmiRpc(umi);

  const builder = transferSol(umi, {
    source: umi.identity,
    destination: toPublicKey('11111111111111111111111111111113'),
    amount: sol(0.01),
  });

  const sig = await submitOrSend(umi, builder, {
    walletAddress: null,
    transactionSender: null,
    agentMode: 'autonomous',
    agentAssetAddress: null,
    agentTokenMint: null,
    agentFeeSol: 0,
    tokenOverride: null,
    ownerWallet: null,
    txCounter: null,
  });

  assert.match(sig, /^DRYRUN_/);
  assert.ok(isDryRunSignature(sig));
  assert.equal(rpcCalls.sendTransaction, 0, 'dry-run must not broadcast');
  assert.equal(rpcCalls.confirmTransaction, 0, 'dry-run must not confirm');
  // The HTTP mock also stays untouched for send/confirm.
  assert.equal(
    rpc.calls.filter((c) => c.method === 'sendTransaction').length,
    0,
  );
});

// ---------------------------------------------------------------------------
// 5. TxCounter — increments on each successful submission
// ---------------------------------------------------------------------------

test('submitOrSend increments txCounter.count by 1 per call (autonomous dry-run path)', async () => {
  Object.assign(process.env, {
    AGENT_MODE: 'autonomous',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    BOOTSTRAP_WALLET: FIXTURE_WALLET,
    SOLANA_RPC_URL: rpc.url,
    ANTHROPIC_API_KEY: 'test',
    AUTONOMOUS_DRY_RUN: 'true',
  });
  const { umi } = makeTestUmi(rpc.url);
  stubUmiRpc(umi);

  const txCounter = { count: 0, max: 3 };
  const context = {
    walletAddress: null,
    transactionSender: null,
    agentMode: 'autonomous' as const,
    agentAssetAddress: null,
    agentTokenMint: null,
    agentFeeSol: 0,
    tokenOverride: null,
    ownerWallet: null,
    txCounter,
  };

  for (let i = 0; i < 3; i++) {
    const builder = transferSol(umi, {
      source: umi.identity,
      destination: toPublicKey('11111111111111111111111111111113'),
      amount: sol(0.01),
    });
    await submitOrSend(umi, builder, context);
  }

  assert.equal(txCounter.count, 3, 'counter incremented once per submission');
});

// ---------------------------------------------------------------------------
// 6. TxCounter cap — submitOrSend throws once count >= max
// ---------------------------------------------------------------------------

test('submitOrSend throws "Per-tick transaction cap reached" when txCounter.count >= max', async () => {
  Object.assign(process.env, {
    AGENT_MODE: 'autonomous',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    BOOTSTRAP_WALLET: FIXTURE_WALLET,
    SOLANA_RPC_URL: rpc.url,
    ANTHROPIC_API_KEY: 'test',
    AUTONOMOUS_DRY_RUN: 'true',
  });
  const { umi } = makeTestUmi(rpc.url);
  stubUmiRpc(umi);

  const txCounter = { count: 3, max: 3 };
  const builder = transferSol(umi, {
    source: umi.identity,
    destination: toPublicKey('11111111111111111111111111111113'),
    amount: sol(0.01),
  });

  await assert.rejects(
    submitOrSend(umi, builder, {
      walletAddress: null,
      transactionSender: null,
      agentMode: 'autonomous',
      agentAssetAddress: null,
      agentTokenMint: null,
      agentFeeSol: 0,
      tokenOverride: null,
      ownerWallet: null,
      txCounter,
    }),
    /Per-tick transaction cap reached \(3\)/,
  );
  // Counter must NOT increment on the rejected call.
  assert.equal(txCounter.count, 3);
});

// ---------------------------------------------------------------------------
// 7. wrapWithExecute — the Core `execute` composition path
// ---------------------------------------------------------------------------
//
// `submitAsAgent` is the real "wrap inner instructions in a Core Execute
// CPI" entry point, but it calls `fetchAsset` over RPC, which would
// require mocking the full Core asset deserialization (32-byte
// discriminator + AssetV1 layout). Instead we exercise the mpl-core
// `execute` builder directly (the same call `submitAsAgent` makes after
// `fetchAsset`), feeding it a synthetic asset shape. This proves the
// composition: the resulting builder contains exactly one instruction,
// the Execute V1 ix, and that ix carries the agent's asset address.

test('mpl-core execute() wraps inner instructions into a single Execute V1 ix targeting the asset', async () => {
  Object.assign(process.env, {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    SOLANA_RPC_URL: rpc.url,
    ANTHROPIC_API_KEY: 'test',
  });
  const { execute } = await import('@metaplex-foundation/mpl-core');
  const { umi } = makeTestUmi(rpc.url);

  const inner = transferSol(umi, {
    source: umi.identity,
    destination: toPublicKey('11111111111111111111111111111113'),
    amount: sol(0.01),
  });

  // execute() expects { asset: { publicKey } } — only `.publicKey` is
  // actually read for ix construction (no on-chain shape needed).
  const wrapped = execute(umi, {
    asset: { publicKey: toPublicKey(FIXTURE_ASSET) } as any,
    instructions: inner,
  });

  const items = wrapped.items;
  assert.equal(items.length, 1, 'wrapped builder has exactly one ix (Execute V1)');
  const ix = items[0].instruction;
  // The Execute V1 program is mpl-core's program. Verify the asset keys
  // appear in the ix's accounts list — that's the load-bearing wiring.
  const accountKeys = ix.keys.map((k) => k.pubkey.toString());
  assert.ok(
    accountKeys.includes(FIXTURE_ASSET),
    `Execute V1 ix accounts must reference the asset; got ${accountKeys.join(',')}`,
  );
});
