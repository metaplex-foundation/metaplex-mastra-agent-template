import { test, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import nacl from 'tweetnacl';
import {
  startMockRpc,
  type MockRpc,
} from '../../../shared/test/helpers/mock-rpc.js';
import {
  isolateEnv,
  restoreEnv,
  defaultTestEnv,
} from '../../../shared/test/helpers/env.js';
import {
  _resetConfigForTests,
  addGoal,
  addTask,
  getState,
  setState,
  setPaused,
} from '@metaplex-foundation/shared';
import { WorkerLoop } from '../../src/worker-loop.js';

/**
 * Integration tests for the autonomous worker loop's tick body.
 *
 * Strategy:
 *   - Skip `start()` (it loops with sleeps). Instead, use the
 *     `_runTickForTests()` escape hatch added to WorkerLoop for testing.
 *   - Stub the agent with a minimal `{ generate }` impl that records calls
 *     and returns canned results (or throws for error-streak tests).
 *   - Mock the RPC for the `getBalance` calls that gatherContext makes.
 *   - Isolate the on-disk `agent-state.json` per test via tmpdir + chdir.
 *
 * The WorkerLoop constructor signature is `(agent, ownerWallet)`. The agent
 * is typed as `ReturnType<typeof createAgent>` — we cast our stub through
 * `as any` since we only exercise the `generate()` shape the loop calls.
 */

const AGENT_KEYPAIR = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));
const OWNER_WALLET = 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2';

let rpc: MockRpc;
let tmpDir: string;
let originalCwd: string;

before(async () => {
  rpc = await startMockRpc();
  // gatherContext always queries the keypair balance. Default to a generic
  // success response; individual tests can re-register handlers if needed.
  rpc.on('getBalance', () => ({ context: { slot: 1 }, value: 0 }));

  // state.ts caches `_statePath` at module scope on first access — once
  // resolved, subsequent tests can't redirect it without re-importing the
  // module. We sidestep that by using ONE tmpDir for the whole suite and
  // wiping `agent-state.json` between tests.
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'worker-loop-test-'));
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
      BOOTSTRAP_WALLET: OWNER_WALLET,
      SOLANA_RPC_URL: rpc.url,
      AGENT_KEYPAIR,
      AUTONOMOUS_DRY_RUN: 'true',
      MAX_TICK_TX_COUNT: '3',
      TICK_INTERVAL_MS: '100',
    }),
  );
  _resetConfigForTests();
});

afterEach(() => {
  restoreEnv();
  _resetConfigForTests();
});

/**
 * Minimal stub of the Mastra agent shape the worker loop touches:
 *   - `generate(messages, { requestContext, maxSteps, abortSignal })`
 *     returns `{ text, toolCalls?, toolResults? }`
 */
interface StubAgent {
  generate: (messages: unknown, opts?: unknown) => Promise<{
    text: string;
    toolCalls?: unknown[];
    toolResults?: unknown[];
  }>;
  calls: { messages: unknown; opts: unknown }[];
}

function makeStubAgent(impl: (call: { messages: unknown; opts: unknown }) => Promise<{
  text: string;
  toolCalls?: unknown[];
  toolResults?: unknown[];
}>): StubAgent {
  const calls: { messages: unknown; opts: unknown }[] = [];
  return {
    calls,
    generate: async (messages, opts) => {
      const entry = { messages, opts };
      calls.push(entry);
      return impl(entry);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Idle tick (no goals/tasks) short-circuits before agent.generate
// ---------------------------------------------------------------------------

test('worker tick is a no-op when there are no active goals or open tasks', async () => {
  const stub = makeStubAgent(async () => ({ text: 'unreachable' }));
  const loop = new WorkerLoop(stub as any, OWNER_WALLET);
  await loop._runTickForTests();

  assert.equal(stub.calls.length, 0, 'agent.generate must not be called on idle tick');
  // lastTickAt is bumped even on idle (proves the tick body ran)
  const state = getState();
  assert.ok(state.lastTickAt, 'lastTickAt should be set after the idle tick');
});

// ---------------------------------------------------------------------------
// 2. Active goal triggers agent.generate; journal records the result text
// ---------------------------------------------------------------------------

test('worker tick with an active goal invokes the agent and appends a journal entry', async () => {
  addGoal('rebalance treasury');

  const stub = makeStubAgent(async () => ({
    text: 'did stuff',
    toolCalls: [],
    toolResults: [],
  }));
  const loop = new WorkerLoop(stub as any, OWNER_WALLET);
  await loop._runTickForTests();

  assert.equal(stub.calls.length, 1, 'agent.generate should be called exactly once');
  // The prompt should have been a user-role message.
  const msgs = stub.calls[0]!.messages as Array<{ role: string; content: string }>;
  assert.ok(Array.isArray(msgs));
  assert.equal(msgs[0].role, 'user');
  assert.match(msgs[0].content, /autonomous agent/);

  // Journal entry should reflect the model's text output.
  const state = getState();
  assert.ok(state.journal.length >= 1, 'journal entry should be appended');
  const last = state.journal[state.journal.length - 1]!;
  assert.equal(last.kind, 'tick');
  assert.match(last.summary, /did stuff/);
  assert.equal(state.errorStreak, 0);
});

test('worker tick with an open task (no goal) still triggers the agent', async () => {
  addTask('warm RPC cache');
  const stub = makeStubAgent(async () => ({ text: 'ok' }));
  const loop = new WorkerLoop(stub as any, OWNER_WALLET);
  await loop._runTickForTests();
  assert.equal(stub.calls.length, 1);
});

// ---------------------------------------------------------------------------
// 3. Paused state short-circuits before agent.generate
// ---------------------------------------------------------------------------

test('worker tick is a no-op when paused, even with active goals', async () => {
  addGoal('do thing');
  setPaused(true, 'manual');

  const stub = makeStubAgent(async () => ({ text: 'unreachable' }));
  const loop = new WorkerLoop(stub as any, OWNER_WALLET);
  await loop._runTickForTests();

  assert.equal(stub.calls.length, 0, 'agent.generate must not be called while paused');
  // lastTickAt still bumps (proves we ran the tick body and short-circuited).
  assert.ok(getState().lastTickAt);
});

// ---------------------------------------------------------------------------
// 4. Error streak auto-pauses at 3
// ---------------------------------------------------------------------------

test('three consecutive agent.generate failures auto-pause the loop and journal each error', async () => {
  addGoal('keep failing');
  const stub = makeStubAgent(async () => {
    throw new Error('boom');
  });
  const loop = new WorkerLoop(stub as any, OWNER_WALLET);

  await loop._runTickForTests();
  await loop._runTickForTests();
  await loop._runTickForTests();

  const state = getState();
  assert.equal(state.errorStreak, 3, 'errorStreak should hit 3 after three failures');
  assert.equal(state.paused, true, 'state should be auto-paused at the threshold');

  // Three 'error' journal entries — one per failed tick. The auto-pause also
  // appends a 'pause' entry, so total >= 4.
  const errorEntries = state.journal.filter((j) => j.kind === 'error');
  assert.equal(errorEntries.length, 3);
  for (const e of errorEntries) {
    assert.match(e.summary, /tick failed/);
    assert.match(e.summary, /boom/);
  }
  const pauseEntries = state.journal.filter((j) => j.kind === 'pause');
  assert.equal(pauseEntries.length, 1, 'auto-pause should write one pause entry');
});

// ---------------------------------------------------------------------------
// 5. Error streak resets after a successful tick
// ---------------------------------------------------------------------------

test('error streak resets to 0 after a successful tick following failures', async () => {
  addGoal('try try try');
  let mode: 'throw' | 'ok' = 'throw';
  const stub = makeStubAgent(async () => {
    if (mode === 'throw') throw new Error('still broken');
    return { text: 'recovered' };
  });
  const loop = new WorkerLoop(stub as any, OWNER_WALLET);

  await loop._runTickForTests();
  await loop._runTickForTests();
  assert.equal(getState().errorStreak, 2, 'two failures should bump streak to 2');
  assert.equal(getState().paused, false, 'two failures should not auto-pause');

  mode = 'ok';
  await loop._runTickForTests();
  assert.equal(getState().errorStreak, 0, 'successful tick should reset streak');
  assert.equal(getState().paused, false);
});

// ---------------------------------------------------------------------------
// 6. Dry-run flag propagates into the RequestContext / prompt
// ---------------------------------------------------------------------------

test('dry-run mode is reflected in the tick prompt the agent receives', async () => {
  addGoal('act safely');
  let captured = '';
  const stub = makeStubAgent(async ({ messages }) => {
    const m = messages as Array<{ role: string; content: string }>;
    captured = m[0]!.content;
    return { text: 'noted' };
  });
  const loop = new WorkerLoop(stub as any, OWNER_WALLET);
  await loop._runTickForTests();
  // AUTONOMOUS_DRY_RUN=true in beforeEach → prompt should call this out.
  assert.match(captured, /Dry run: ENABLED/);
  assert.match(captured, /simulated, not broadcast/);
});

// ---------------------------------------------------------------------------
// 7. TxCounter cap value propagates into the prompt
// ---------------------------------------------------------------------------

test('per-tick tx cap (MAX_TICK_TX_COUNT) is surfaced in the tick prompt', async () => {
  addGoal('be bounded');
  let captured = '';
  const stub = makeStubAgent(async ({ messages }) => {
    const m = messages as Array<{ role: string; content: string }>;
    captured = m[0]!.content;
    return { text: 'noted' };
  });
  const loop = new WorkerLoop(stub as any, OWNER_WALLET);
  await loop._runTickForTests();
  // MAX_TICK_TX_COUNT=3 in beforeEach.
  assert.match(captured, /Per-tick transaction cap: 3/);
});

test('per-tick tx counter is wired into the RequestContext as txCounter', async () => {
  addGoal('inspect ctx');
  let counterRef: { count: number; max: number } | undefined;
  const stub = makeStubAgent(async ({ opts }) => {
    // The worker loop passes a RequestContext on opts.requestContext. It
    // exposes Map-like .get() — pull the txCounter and check shape.
    const rc = (opts as any).requestContext;
    counterRef = rc?.get?.('txCounter');
    return { text: 'looked at ctx' };
  });
  const loop = new WorkerLoop(stub as any, OWNER_WALLET);
  await loop._runTickForTests();
  assert.ok(counterRef, 'requestContext should contain a txCounter');
  assert.equal(counterRef!.count, 0);
  assert.equal(counterRef!.max, 3);
});

// ---------------------------------------------------------------------------
// 8. Tool-only turn (no text) still records a summary
// ---------------------------------------------------------------------------

test('tool-only turn synthesizes a journal summary from the tool names', async () => {
  addGoal('act with tools');
  const stub = makeStubAgent(async () => ({
    text: '',
    toolCalls: [
      { toolName: 'get-balance', args: {}, result: {} },
      { toolName: 'add-task', args: {}, result: {} },
    ],
    toolResults: [],
  }));
  const loop = new WorkerLoop(stub as any, OWNER_WALLET);
  await loop._runTickForTests();
  const last = getState().journal.at(-1)!;
  assert.match(last.summary, /tool-only turn/);
  assert.match(last.summary, /get-balance/);
  assert.match(last.summary, /add-task/);
});

// ---------------------------------------------------------------------------
// 9. Tool result signatures are collected into journal.txSigs
// ---------------------------------------------------------------------------

test('signatures from tool results land in the journal entry txSigs array', async () => {
  addGoal('sign things');
  const stub = makeStubAgent(async () => ({
    text: 'submitted',
    toolCalls: [],
    toolResults: [
      { result: { signature: 'SigOne1111' } },
      { result: { signature: 'SigTwo2222' } },
      { result: { somethingElse: true } },
    ],
  }));
  const loop = new WorkerLoop(stub as any, OWNER_WALLET);
  await loop._runTickForTests();
  const last = getState().journal.at(-1)!;
  assert.deepEqual(last.txSigs, ['SigOne1111', 'SigTwo2222']);
});

// ---------------------------------------------------------------------------
// 10. stop() before start() is a no-op
// ---------------------------------------------------------------------------

test('stop() before start() returns cleanly (idempotent)', async () => {
  const stub = makeStubAgent(async () => ({ text: '' }));
  const loop = new WorkerLoop(stub as any, OWNER_WALLET);
  await loop.stop(); // should not throw
});

// ---------------------------------------------------------------------------
// 11. start() / stop() lifecycle: at least one tick runs before stop
// ---------------------------------------------------------------------------

test('start() drives ticks until stop() is called', async () => {
  addGoal('keep going');
  // Resolve the promise on the first call so we know the loop fired.
  let firstTickResolve: () => void = () => {};
  const firstTick = new Promise<void>((r) => { firstTickResolve = r; });

  const stub = makeStubAgent(async () => {
    firstTickResolve();
    return { text: 'tick' };
  });

  // Override TICK_INTERVAL_MS to keep this fast — set inside the env, but the
  // config has already been parsed in beforeEach with TICK_INTERVAL_MS=100,
  // which is short enough.
  const loop = new WorkerLoop(stub as any, OWNER_WALLET);
  loop.start();
  await firstTick;
  await loop.stop();
  assert.ok(stub.calls.length >= 1, 'at least one tick should have run');
});

// ---------------------------------------------------------------------------
// 12. RequestContext shape — ownerWallet + agentMode are wired through
// ---------------------------------------------------------------------------

test('worker tick wires ownerWallet and agentMode=autonomous into the RequestContext', async () => {
  addGoal('inspect ctx');
  let captured: { ownerWallet?: unknown; agentMode?: unknown; walletAddress?: unknown } = {};
  const stub = makeStubAgent(async ({ opts }) => {
    const rc = (opts as any).requestContext;
    captured = {
      ownerWallet: rc?.get?.('ownerWallet'),
      agentMode: rc?.get?.('agentMode'),
      walletAddress: rc?.get?.('walletAddress'),
    };
    return { text: 'ok' };
  });
  const loop = new WorkerLoop(stub as any, OWNER_WALLET);
  await loop._runTickForTests();
  assert.equal(captured.ownerWallet, OWNER_WALLET);
  assert.equal(captured.walletAddress, OWNER_WALLET);
  assert.equal(captured.agentMode, 'autonomous');
});

// ---------------------------------------------------------------------------
// 13. Done/failed tasks are excluded from the "open tasks" check
// ---------------------------------------------------------------------------

test('worker tick is idle when only done/failed tasks remain (no agent call)', async () => {
  // Seed a task and then mark it done by directly rewriting state — simpler
  // than building closeTask side effects into the test setup.
  const t = addTask('do then close');
  setState({
    tasks: getState().tasks.map((x) =>
      x.id === t.id ? { ...x, status: 'done', completedAt: new Date().toISOString(), result: 'ok' } : x,
    ),
  });
  const stub = makeStubAgent(async () => ({ text: 'unreachable' }));
  const loop = new WorkerLoop(stub as any, OWNER_WALLET);
  await loop._runTickForTests();
  assert.equal(stub.calls.length, 0, 'closed tasks should not keep the loop awake');
});
