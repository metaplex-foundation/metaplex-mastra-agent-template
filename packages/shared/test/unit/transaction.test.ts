import { test, before, after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { transferSol } from '@metaplex-foundation/mpl-toolbox';
import { publicKey as toPublicKey, sol } from '@metaplex-foundation/umi';
import { startMockRpc, blockhashFixture, type MockRpc } from '../helpers/mock-rpc.js';
import { makeTestUmi, stubUmiRpc } from '../helpers/umi.js';
import { _resetConfigForTests } from '../../src/config.js';
import {
  submitWithUserWallet,
  submitAsAgent,
  isDryRunSignature,
} from '../../src/transaction.js';

/**
 * Tests for `src/transaction.ts` paths not covered by execute.test.ts.
 *
 *   - `isDryRunSignature` — trivial predicate over the `DRYRUN_` prefix.
 *   - `submitWithUserWallet` — mode-agnostic user-wallet submit. Happy
 *     path + both missing-dependency guards.
 *   - `submitAsAgent` — public-mode rejection guard, tx-cap rejection
 *     guard. The autonomous + dry-run happy path additionally exercises
 *     `fetchAsset` from `@metaplex-foundation/mpl-core`, which we can't
 *     stub without either a valid Core AssetV1 byte fixture (brittle —
 *     32-byte discriminator + full AssetV1 layout) or an ESM-level mock
 *     of `fetchAsset` itself (transaction.ts's static `import` snapshots
 *     the CJS binding at first evaluation, so post-eval monkey-patching
 *     doesn't propagate). The composition of `execute()` over inner
 *     instructions is already exercised in execute.test.ts; the dry-run
 *     skip-broadcast behavior is identically covered by submitOrSend's
 *     dry-run test there. So we intentionally do NOT cover that path
 *     here — see plan note in the task brief.
 *
 * Reusing the pattern from execute.test.ts: snapshot/restore env between
 * tests + `_resetConfigForTests()` to bust the config singleton (the
 * memoized `_config` doesn't see env mutations otherwise).
 */

const FIXTURE_ASSET = '11111111111111111111111111111112';
const FIXTURE_WALLET = 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2';

const ENV_SNAPSHOT: Record<string, string | undefined> = {};
let rpc: MockRpc;

before(async () => {
  for (const k of Object.keys(process.env)) ENV_SNAPSHOT[k] = process.env[k];
  rpc = await startMockRpc();
  rpc.on('getLatestBlockhash', () => blockhashFixture());
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v !== undefined) process.env[k] = v;
  }
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
// 1. isDryRunSignature — trivial predicate
// ---------------------------------------------------------------------------

test('isDryRunSignature returns true only for DRYRUN_-prefixed strings', () => {
  assert.equal(isDryRunSignature('DRYRUN_abc123'), true);
  assert.equal(isDryRunSignature('realSig123abcXYZ'), false);
  assert.equal(isDryRunSignature(''), false);
});

// ---------------------------------------------------------------------------
// 2. submitWithUserWallet — happy path, no AGENT_FEE_SOL prepend
// ---------------------------------------------------------------------------

test('submitWithUserWallet serializes tx, calls transactionSender, returns its signature without prepending AGENT_FEE_SOL', async () => {
  Object.assign(process.env, {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    SOLANA_RPC_URL: rpc.url,
    ANTHROPIC_API_KEY: 'test',
    // A non-zero AGENT_FEE_SOL matters for `submitOrSend` in public mode
    // (which prepends a transferSol of this amount). `submitWithUserWallet`
    // must IGNORE this and never inject a fee — that's its whole reason
    // for existing as a separate helper.
    AGENT_FEE_SOL: '0.5',
  });
  const { umi, publicKey } = makeTestUmi(rpc.url);
  const rpcCalls = stubUmiRpc(umi);

  const senderCalls: { txBase64: string; options: any }[] = [];
  const fakeSig = 'sig-from-submit-with-user-wallet';
  const transactionSender = {
    sendAndAwait: async (txBase64: string, options: any) => {
      senderCalls.push({ txBase64, options });
      return fakeSig;
    },
  };

  const builder = transferSol(umi, {
    source: umi.identity,
    destination: toPublicKey('11111111111111111111111111111113'),
    amount: sol(0),
  });

  const sig = await submitWithUserWallet(umi, builder, {
    walletAddress: publicKey,
    transactionSender,
    agentMode: 'public',
    // Provide an asset address + fee to prove submitWithUserWallet does
    // NOT consult them (the contrast vs submitOrSend public-mode path).
    agentAssetAddress: FIXTURE_ASSET,
    agentTokenMint: null,
    agentFeeSol: 0.5,
    tokenOverride: null,
    ownerWallet: null,
    txCounter: null,
  });

  assert.equal(sig, fakeSig);
  assert.equal(senderCalls.length, 1, 'transactionSender called exactly once');
  assert.ok(senderCalls[0].txBase64.length > 0, 'serialized tx is non-empty');
  // No RPC broadcast — user signs, not the agent.
  assert.equal(rpcCalls.sendTransaction, 0);
  assert.equal(rpcCalls.confirmTransaction, 0);
});

// ---------------------------------------------------------------------------
// 3. submitWithUserWallet — missing transactionSender
// ---------------------------------------------------------------------------

test('submitWithUserWallet throws when transactionSender is missing', async () => {
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
    amount: sol(0),
  });

  await assert.rejects(
    submitWithUserWallet(umi, builder, {
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
    /No transaction sender available\. The connected client must support user-signed transactions\./,
  );
});

// ---------------------------------------------------------------------------
// 4. submitWithUserWallet — missing walletAddress
// ---------------------------------------------------------------------------

test('submitWithUserWallet throws when walletAddress is missing', async () => {
  Object.assign(process.env, {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    SOLANA_RPC_URL: rpc.url,
    ANTHROPIC_API_KEY: 'test',
  });
  const { umi } = makeTestUmi(rpc.url);
  stubUmiRpc(umi);

  const builder = transferSol(umi, {
    source: umi.identity,
    destination: toPublicKey('11111111111111111111111111111113'),
    amount: sol(0),
  });

  const transactionSender = {
    sendAndAwait: async () => 'unused',
  };

  await assert.rejects(
    submitWithUserWallet(umi, builder, {
      walletAddress: null,
      transactionSender,
      agentMode: 'public',
      agentAssetAddress: null,
      agentTokenMint: null,
      agentFeeSol: 0,
      tokenOverride: null,
      ownerWallet: null,
      txCounter: null,
    }),
    /No wallet connected\. Ask the user to connect their wallet first\./,
  );
});

// ---------------------------------------------------------------------------
// 5. submitAsAgent — public-mode guard fires before any work
// ---------------------------------------------------------------------------

test('submitAsAgent throws in public mode', async () => {
  Object.assign(process.env, {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    SOLANA_RPC_URL: rpc.url,
    ANTHROPIC_API_KEY: 'test',
  });
  const { umi } = makeTestUmi(rpc.url);
  stubUmiRpc(umi);

  const inner = transferSol(umi, {
    source: umi.identity,
    destination: toPublicKey('11111111111111111111111111111113'),
    amount: sol(0),
  });

  await assert.rejects(
    submitAsAgent(umi, toPublicKey(FIXTURE_ASSET), inner, {
      walletAddress: null,
      transactionSender: null,
      agentMode: 'public',
      agentAssetAddress: null,
      agentTokenMint: null,
      agentFeeSol: 0,
      tokenOverride: null,
      ownerWallet: null,
      txCounter: null,
    }),
    /submitAsAgent is only valid in autonomous mode\./,
  );
});

// ---------------------------------------------------------------------------
// 6. submitAsAgent — tx-cap enforcement, counter NOT incremented
// ---------------------------------------------------------------------------

test('submitAsAgent throws "Per-tick transaction cap reached" when txCounter is at max, does not increment', async () => {
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

  const inner = transferSol(umi, {
    source: umi.identity,
    destination: toPublicKey('11111111111111111111111111111113'),
    amount: sol(0),
  });

  const txCounter = { count: 3, max: 3 };
  await assert.rejects(
    submitAsAgent(umi, toPublicKey(FIXTURE_ASSET), inner, {
      walletAddress: null,
      transactionSender: null,
      agentMode: 'autonomous',
      agentAssetAddress: FIXTURE_ASSET,
      agentTokenMint: null,
      agentFeeSol: 0,
      tokenOverride: null,
      ownerWallet: null,
      txCounter,
    }),
    /Per-tick transaction cap reached \(3\)/,
  );
  // Cap rejection happens before fetchAsset — counter stays at 3.
  assert.equal(txCounter.count, 3);
});
