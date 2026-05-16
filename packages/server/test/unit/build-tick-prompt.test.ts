import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Goal, JournalEntry, Task } from '@metaplex-foundation/shared';
import { buildTickPrompt, type TickContext } from '../../src/build-tick-prompt.js';

/**
 * Unit tests for `buildTickPrompt`. This function is the single deterministic
 * surface that renders the autonomous tick into a prompt — it must be:
 *   - byte-deterministic for a given TickContext (no Date.now() / Math.random())
 *   - inclusive of every actionable item (goals, tasks, balances)
 *   - graceful when collections are empty
 *   - explicit about safety flags (dry-run, tx cap)
 */

const FIXED_TS = '2026-05-16T12:00:00.000Z';

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'g_aaaaaaaa',
    description: 'rebalance treasury',
    createdAt: FIXED_TS,
    status: 'active',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't_aaaaaaaa',
    goalId: null,
    description: 'swap MPLX -> USDC',
    status: 'pending',
    createdAt: FIXED_TS,
    completedAt: null,
    result: null,
    ...overrides,
  };
}

function makeJournalEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    ts: FIXED_TS,
    kind: 'tick',
    summary: 'standing down',
    txSigs: [],
    ...overrides,
  };
}

function baseCtx(overrides: Partial<TickContext> = {}): TickContext {
  return {
    nowIso: FIXED_TS,
    agentKeypairAddress: 'AgentKeypairAddressPlaceholder111111111111',
    agentKeypairBalanceSol: 1.2345,
    agentPdaAddress: null,
    agentPdaBalanceSol: null,
    goals: [],
    openTasks: [],
    recentlyClosedTasks: [],
    recentJournal: [],
    txCapMax: 3,
    dryRun: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Deterministic output
// ---------------------------------------------------------------------------

test('buildTickPrompt returns byte-identical output for the same context', () => {
  const ctx = baseCtx({
    goals: [makeGoal()],
    openTasks: [makeTask()],
    recentJournal: [makeJournalEntry()],
  });
  const a = buildTickPrompt(ctx);
  const b = buildTickPrompt(ctx);
  const c = buildTickPrompt(ctx);
  assert.equal(a, b);
  assert.equal(b, c);
});

test('buildTickPrompt output is identical across two fresh equal contexts (no hidden state)', () => {
  const a = buildTickPrompt(baseCtx());
  const b = buildTickPrompt(baseCtx());
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// 2. Includes essentials
// ---------------------------------------------------------------------------

test('buildTickPrompt includes the agent keypair balance and address', () => {
  const ctx = baseCtx({
    agentKeypairAddress: 'KP_addr_abcdef',
    agentKeypairBalanceSol: 2.5,
  });
  const out = buildTickPrompt(ctx);
  assert.match(out, /KP_addr_abcdef/);
  // formatSol trims trailing zeros; 2.5 stays as "2.5"
  assert.match(out, /2\.5 SOL/);
});

test('buildTickPrompt includes PDA address and balance when registered', () => {
  const ctx = baseCtx({
    agentPdaAddress: 'PDA_addr_xyz',
    agentPdaBalanceSol: 0.42,
  });
  const out = buildTickPrompt(ctx);
  assert.match(out, /PDA_addr_xyz/);
  assert.match(out, /0\.42 SOL/);
  // "treasury" label disambiguates the PDA line from the keypair line.
  assert.match(out, /treasury/);
});

test('buildTickPrompt shows PDA "unknown" balance gracefully when address set but balance fetch failed', () => {
  const ctx = baseCtx({
    agentPdaAddress: 'PDA_addr_xyz',
    agentPdaBalanceSol: null,
  });
  const out = buildTickPrompt(ctx);
  assert.match(out, /PDA_addr_xyz/);
  assert.match(out, /unknown/);
});

test('buildTickPrompt marks PDA "not yet registered" when address is null', () => {
  const out = buildTickPrompt(baseCtx({ agentPdaAddress: null }));
  assert.match(out, /not yet registered/i);
  assert.match(out, /register-agent/);
});

test('buildTickPrompt lists every active goal by id and description', () => {
  const goals: Goal[] = [
    makeGoal({ id: 'g_one', description: 'rebalance treasury' }),
    makeGoal({ id: 'g_two', description: 'grow holders' }),
    makeGoal({ id: 'g_three', description: 'launch token' }),
  ];
  const out = buildTickPrompt(baseCtx({ goals }));
  assert.match(out, /Active goals \(3\)/);
  for (const g of goals) {
    assert.ok(out.includes(g.id), `missing goal id ${g.id}`);
    assert.ok(out.includes(g.description), `missing goal description ${g.description}`);
  }
});

test('buildTickPrompt lists every open task with status and goal link', () => {
  const tasks: Task[] = [
    makeTask({ id: 't_one', description: 'fetch quote', goalId: 'g_one', status: 'pending' }),
    makeTask({ id: 't_two', description: 'submit swap', goalId: null, status: 'in_progress' }),
  ];
  const out = buildTickPrompt(baseCtx({ openTasks: tasks }));
  assert.match(out, /Open tasks \(2\)/);
  assert.ok(out.includes('t_one'));
  assert.ok(out.includes('[pending]'));
  assert.ok(out.includes('[goal: g_one]'));
  assert.ok(out.includes('t_two'));
  assert.ok(out.includes('[in_progress]'));
  // Orphan task should NOT print a "[goal: ...]" tag.
  assert.equal(out.match(/\[goal: /g)?.length, 1);
});

test('buildTickPrompt shows "none" placeholders when goals and tasks are empty', () => {
  const out = buildTickPrompt(baseCtx());
  assert.match(out, /## Active goals\n\(none/);
  assert.match(out, /## Open tasks\n\(none/);
});

// ---------------------------------------------------------------------------
// 3. Journal handling — last 5 (already pre-truncated upstream)
// ---------------------------------------------------------------------------

test('buildTickPrompt renders all journal entries it is handed (caller pre-truncates)', () => {
  // worker-loop.ts does state.journal.slice(-5) before passing in; buildTickPrompt
  // itself is intentionally not opinionated about truncation. Verify it renders
  // every entry it receives, with timestamp + kind + summary.
  const entries: JournalEntry[] = Array.from({ length: 5 }, (_, i) =>
    makeJournalEntry({
      ts: `2026-05-16T12:0${i}:00.000Z`,
      kind: 'tick',
      summary: `entry-${i}`,
      txSigs: [],
    }),
  );
  const out = buildTickPrompt(baseCtx({ recentJournal: entries }));
  assert.match(out, /Recent journal \(last 5\)/);
  for (const e of entries) {
    assert.ok(out.includes(e.summary), `missing journal summary ${e.summary}`);
    assert.ok(out.includes(e.ts), `missing journal ts ${e.ts}`);
  }
});

test('buildTickPrompt journal section is omitted when recentJournal is empty', () => {
  const out = buildTickPrompt(baseCtx({ recentJournal: [] }));
  assert.equal(out.includes('Recent journal'), false);
});

test('buildTickPrompt includes tx signatures in journal entries when present', () => {
  const entry = makeJournalEntry({
    summary: 'swapped',
    txSigs: ['SigAAA111', 'SigBBB222'],
  });
  const out = buildTickPrompt(baseCtx({ recentJournal: [entry] }));
  assert.match(out, /sigs=SigAAA111,SigBBB222/);
});

// ---------------------------------------------------------------------------
// 4. Closed task truncation — caller pre-truncates to 5
// ---------------------------------------------------------------------------

test('buildTickPrompt omits the closed-tasks section when none are recently closed', () => {
  const out = buildTickPrompt(baseCtx({ recentlyClosedTasks: [] }));
  assert.equal(out.includes('Recently closed tasks'), false);
});

test('buildTickPrompt renders up to 5 recently closed tasks with status and result', () => {
  const closed: Task[] = Array.from({ length: 5 }, (_, i) =>
    makeTask({
      id: `t_done_${i}`,
      description: `task ${i}`,
      status: 'done',
      result: `sig:${i}`,
      completedAt: FIXED_TS,
    }),
  );
  const out = buildTickPrompt(baseCtx({ recentlyClosedTasks: closed }));
  assert.match(out, /Recently closed tasks \(last 5\)/);
  for (const t of closed) {
    assert.ok(out.includes(t.id), `missing closed task id ${t.id}`);
    assert.ok(out.includes('[done]'), 'missing status tag');
    assert.ok(out.includes(t.result!), `missing result for ${t.id}`);
  }
});

test('buildTickPrompt renders "(no result recorded)" for closed tasks with null result', () => {
  const closed = [makeTask({ id: 't_fail', status: 'failed', result: null })];
  const out = buildTickPrompt(baseCtx({ recentlyClosedTasks: closed }));
  assert.match(out, /\(no result recorded\)/);
});

// ---------------------------------------------------------------------------
// 5. Dry-run flag
// ---------------------------------------------------------------------------

test('buildTickPrompt surfaces dry-run ENABLED messaging when dryRun=true', () => {
  const out = buildTickPrompt(baseCtx({ dryRun: true }));
  assert.match(out, /Dry run: ENABLED/);
  assert.match(out, /simulated, not broadcast/);
});

test('buildTickPrompt surfaces dry-run disabled messaging when dryRun=false', () => {
  const out = buildTickPrompt(baseCtx({ dryRun: false }));
  assert.match(out, /Dry run: disabled/);
  assert.match(out, /will hit the network/);
});

// ---------------------------------------------------------------------------
// 6. TxCounter cap
// ---------------------------------------------------------------------------

test('buildTickPrompt prints the configured per-tick transaction cap', () => {
  const out = buildTickPrompt(baseCtx({ txCapMax: 3 }));
  assert.match(out, /Per-tick transaction cap: 3/);
});

test('buildTickPrompt reflects an alternative tx cap value', () => {
  const out = buildTickPrompt(baseCtx({ txCapMax: 12 }));
  assert.match(out, /Per-tick transaction cap: 12/);
});

// ---------------------------------------------------------------------------
// 7. Structural sanity — header, instructions, single trailing-newline-free string
// ---------------------------------------------------------------------------

test('buildTickPrompt always starts with the autonomous-tick header line', () => {
  const out = buildTickPrompt(baseCtx());
  assert.ok(
    out.startsWith('You are an autonomous agent. This is a scheduled tick'),
    `prompt should start with the autonomous-tick header, got: ${out.slice(0, 80)}`,
  );
});

test('buildTickPrompt always ends with the instructions block', () => {
  const out = buildTickPrompt(baseCtx());
  assert.match(out, /## Instructions/);
  assert.match(out, /under 200 characters/);
});

test('buildTickPrompt returns a single joined string (not array, not undefined)', () => {
  const out = buildTickPrompt(baseCtx());
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
});
