import { test, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import nacl from 'tweetnacl';
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
import { withdrawSol } from '../../../src/tools/autonomous/withdraw-sol.js';

/**
 * Integration tests for the `withdraw-sol` autonomous tool.
 *
 * withdraw-sol has two source modes:
 *   - 'keypair' → submitOrSend with agent identity as source
 *   - 'pda'     → submitAsAgent with the asset signer PDA via Core Execute CPI
 *
 * Default config keeps AUTONOMOUS_DRY_RUN=true, so submits return synthetic
 * DRYRUN_<id> signatures without hitting RPC for sendAndConfirm. We still
 * need a blockhash fixture because `buildAndSign` resolves it.
 *
 * Tests covered:
 *   1. source='keypair' in dry-run → DRYRUN_ signature; tx counter advances.
 *   2. source='pda' without agentAssetAddress → INVALID_INPUT, counter unchanged.
 *   3. Per-tick tx cap reached → submitOrSend throws → "Withdraw failed" wrap.
 *   4. Zod rejects unknown source.
 *   5. Zod rejects non-positive amount.
 *   6. Zod rejects malformed destination address.
 *
 * Skipped: the PDA happy path. It calls fetchAsset() on the registry asset,
 * which requires a real on-chain MPL Core account fixture — out of scope.
 */

const AGENT_KEYPAIR = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));
const DESTINATION = 'BPFLoaderUpgradeab1e11111111111111111111111';
const AGENT_ASSET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const BOOTSTRAP = 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2';

let rpc: MockRpc;
let tmpDir: string;
let originalCwd: string;

before(async () => {
  rpc = await startMockRpc();
  rpc.on('getLatestBlockhash', () => blockhashFixture());
  // Some umi paths call getEpochInfo when building.
  rpc.on('getEpochInfo', () => ({ epoch: 1, slotIndex: 1, slotsInEpoch: 432000, absoluteSlot: 1 }));

  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'withdraw-sol-test-'));
  writeFileSync(join(tmpDir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  process.chdir(tmpDir);
});

after(async () => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
  await rpc.close();
});

beforeEach(() => {
  const f = join(tmpDir, 'agent-state.json');
  if (existsSync(f)) unlinkSync(f);
  isolateEnv(
    defaultTestEnv({
      AGENT_MODE: 'autonomous',
      BOOTSTRAP_WALLET: BOOTSTRAP,
      SOLANA_RPC_URL: rpc.url,
      AGENT_KEYPAIR,
      AUTONOMOUS_DRY_RUN: 'true',
    }),
  );
  _resetConfigForTests();
});

afterEach(() => {
  restoreEnv();
  _resetConfigForTests();
});

test("withdraw-sol source='keypair' in dry-run returns a DRYRUN signature and increments the tx counter", async () => {
  const counter = { count: 0, max: 3 };

  const result = (await withdrawSol.execute!(
    { source: 'keypair', destination: DESTINATION, amount: 0.1 },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        txCounter: counter,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'success');
  assert.match(result.signature, /^DRYRUN_/);
  assert.match(result.message, /from keypair/);
  assert.equal(counter.count, 1);
});

test("withdraw-sol source='pda' without agentAssetAddress returns INVALID_INPUT", async () => {
  const counter = { count: 0, max: 3 };

  const result = (await withdrawSol.execute!(
    { source: 'pda', destination: DESTINATION, amount: 0.1 },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: null,
        txCounter: counter,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'INVALID_INPUT');
  assert.match(result.message, /not registered/);
  assert.equal(counter.count, 0, 'counter must not advance when the call short-circuits');
});

test("withdraw-sol source='keypair' wraps the per-tick cap as a Withdraw-failed error", async () => {
  const counter = { count: 3, max: 3 }; // already at cap

  const result = (await withdrawSol.execute!(
    { source: 'keypair', destination: DESTINATION, amount: 0.1 },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        txCounter: counter,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.match(result.message, /Withdraw failed/);
  assert.match(result.message, /cap/i);
});

test('withdraw-sol rejects unknown source via Zod', async () => {
  const result = (await withdrawSol.execute!(
    { source: 'somewhere', destination: DESTINATION, amount: 0.1 } as any,
    {
      requestContext: fakeContext({ agentMode: 'autonomous' }),
    } as any,
  )) as any;

  assert.equal(result.error, true);
});

test('withdraw-sol rejects non-positive amount via Zod', async () => {
  const result = (await withdrawSol.execute!(
    { source: 'keypair', destination: DESTINATION, amount: 0 } as any,
    {
      requestContext: fakeContext({ agentMode: 'autonomous' }),
    } as any,
  )) as any;

  assert.equal(result.error, true);
});

test('withdraw-sol rejects malformed destination via Zod', async () => {
  const result = (await withdrawSol.execute!(
    { source: 'keypair', destination: 'not-base58', amount: 0.1 } as any,
    {
      requestContext: fakeContext({ agentMode: 'autonomous' }),
    } as any,
  )) as any;

  assert.equal(result.error, true);
});

test("withdraw-sol source='pda' with agentAssetAddress proceeds past the validation gate (then needs fetchAsset)", async () => {
  // We don't expect this to succeed — fetchAsset hits the mock RPC for the
  // asset account, which we haven't stubbed. The point is to confirm the
  // validation gate is passed and the failure wraps as a Withdraw-failed
  // error rather than INVALID_INPUT.
  const counter = { count: 0, max: 3 };

  const result = (await withdrawSol.execute!(
    { source: 'pda', destination: DESTINATION, amount: 0.1 },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
        txCounter: counter,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.match(result.message, /Withdraw failed/);
  // Must NOT be the INVALID_INPUT pre-check.
  assert.notEqual(result.code, 'INVALID_INPUT');
});
