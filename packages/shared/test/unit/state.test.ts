import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * state.ts caches `_statePath` at module scope on first call to `getStatePath()`.
 * To force a fresh resolution against a new `process.cwd()` per test we
 * dynamic-import with a query-string cache buster — ESM keys modules by URL,
 * so `?bust=N` produces a new module instance each time.
 *
 * Each test:
 *   1. mkdtempSync — new isolated working dir
 *   2. drops a pnpm-workspace.yaml marker so findStateFile anchors there
 *   3. chdir into it, import state.js?bust=<unique>
 *   4. afterEach restores the original cwd and rms the tmp dir
 *
 * Test-file isolation: `node --test` spawns each *.test.ts in its own worker
 * process, so chdir in this file doesn't bleed into sibling test files.
 */

let tmpDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'state-test-'));
  // Anchor findStateFile() to tmpDir by planting the workspace marker.
  writeFileSync(join(tmpDir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

async function loadStateFresh() {
  process.chdir(tmpDir);
  const bust = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return await import(`../../src/state.js?bust=${bust}`);
}

function stateFile(): string {
  return join(tmpDir, 'agent-state.json');
}

// ---------------------------------------------------------------------------
// 1. Default state shape
// ---------------------------------------------------------------------------

test('getState returns default shape when no file exists', async () => {
  const { getState } = await loadStateFresh();
  const s = getState();
  assert.deepEqual(s.goals, []);
  assert.deepEqual(s.tasks, []);
  assert.deepEqual(s.journal, []);
  assert.equal(s.paused, false);
  assert.equal(s.errorStreak, 0);
  assert.equal(s.lastTickAt, null);
  assert.equal(s.agentAssetAddress, undefined);
  assert.equal(s.agentTokenMint, undefined);
  // getState() is a pure read — should NOT create a file as a side effect.
  assert.equal(existsSync(stateFile()), false);
});

// ---------------------------------------------------------------------------
// 2. Round trip via setState
// ---------------------------------------------------------------------------

test('setState round-trips agentAssetAddress and writes the file', async () => {
  const { setState, getState } = await loadStateFresh();
  setState({ agentAssetAddress: 'abc123' });
  assert.equal(getState().agentAssetAddress, 'abc123');
  assert.equal(existsSync(stateFile()), true);
  const onDisk = JSON.parse(readFileSync(stateFile(), 'utf-8'));
  assert.equal(onDisk.agentAssetAddress, 'abc123');
});

// ---------------------------------------------------------------------------
// 3. addGoal — shape, id prefix, persistence across module reload
// ---------------------------------------------------------------------------

test('addGoal returns active goal with g_ id and persists across reload', async () => {
  const { addGoal } = await loadStateFresh();
  const g = addGoal('rebalance treasury');
  assert.equal(g.status, 'active');
  assert.match(g.id, /^g_/);
  assert.equal(g.description, 'rebalance treasury');
  assert.equal(typeof g.createdAt, 'string');

  // Re-import to confirm the goal survives a fresh module evaluation.
  const fresh = await loadStateFresh();
  const reloaded = fresh.getState().goals;
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].id, g.id);
  assert.equal(reloaded[0].description, 'rebalance treasury');
  assert.equal(reloaded[0].status, 'active');
});

// ---------------------------------------------------------------------------
// 4. closeGoal — mutates status; returns null for missing id
// ---------------------------------------------------------------------------

test('closeGoal flips status to achieved, returns null for unknown id', async () => {
  const { addGoal, closeGoal, getState } = await loadStateFresh();
  const g = addGoal('grow holders');
  const closed = closeGoal(g.id, 'achieved');
  assert.ok(closed);
  assert.equal(closed!.status, 'achieved');
  assert.equal(closed!.id, g.id);
  assert.equal(getState().goals[0].status, 'achieved');

  // Unknown id is a no-op returning null.
  const missing = closeGoal('g_doesnotexist', 'abandoned');
  assert.equal(missing, null);
});

// ---------------------------------------------------------------------------
// 5. getGoalById — find/miss
// ---------------------------------------------------------------------------

test('getGoalById finds existing goal and returns null when missing', async () => {
  const { addGoal, getGoalById } = await loadStateFresh();
  const g = addGoal('seed liquidity');
  const found = getGoalById(g.id);
  assert.ok(found);
  assert.equal(found!.id, g.id);
  assert.equal(found!.description, 'seed liquidity');

  assert.equal(getGoalById('g_missing'), null);
});

// ---------------------------------------------------------------------------
// 6. addTask — orphan (goalId: null) and goal-linked variants
// ---------------------------------------------------------------------------

test('addTask creates pending task with t_ id, supports orphan and linked goalIds', async () => {
  const { addGoal, addTask, getState } = await loadStateFresh();

  // Orphan task — no goal.
  const orphan = addTask('warm up RPC cache');
  assert.equal(orphan.status, 'pending');
  assert.match(orphan.id, /^t_/);
  assert.equal(orphan.goalId, null);
  assert.equal(orphan.completedAt, null);
  assert.equal(orphan.result, null);

  // Goal-linked task.
  const g = addGoal('rebalance');
  const linked = addTask('swap MPLX -> USDC', g.id);
  assert.equal(linked.goalId, g.id);
  assert.equal(linked.status, 'pending');

  const tasks = getState().tasks;
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].id, orphan.id);
  assert.equal(tasks[1].id, linked.id);
});

// ---------------------------------------------------------------------------
// 7. closeTask — done/failed transitions; missing id returns null
// ---------------------------------------------------------------------------

test('closeTask sets done status, records result and completedAt, returns null for unknown id', async () => {
  const { addTask, closeTask, getState } = await loadStateFresh();
  const t = addTask('mint asset');
  const closed = closeTask(t.id, 'done', 'sig:abc');
  assert.ok(closed);
  assert.equal(closed!.status, 'done');
  assert.equal(closed!.result, 'sig:abc');
  assert.equal(typeof closed!.completedAt, 'string');
  assert.ok(closed!.completedAt!.length > 0);
  assert.equal(getState().tasks[0].status, 'done');

  assert.equal(closeTask('t_missing', 'failed', 'nope'), null);
});

test('closeTask supports failed status', async () => {
  const { addTask, closeTask } = await loadStateFresh();
  const t = addTask('risky op');
  const closed = closeTask(t.id, 'failed', 'rpc timeout');
  assert.ok(closed);
  assert.equal(closed!.status, 'failed');
  assert.equal(closed!.result, 'rpc timeout');
});

// ---------------------------------------------------------------------------
// 8. appendJournal — ts defaulting, summary truncation, txSigs default, ordering
// ---------------------------------------------------------------------------

test('appendJournal defaults ts, truncates summary to 500 chars, defaults txSigs to []', async () => {
  const { appendJournal, getState } = await loadStateFresh();
  const longSummary = 'x'.repeat(750);
  const entry = appendJournal({ kind: 'tick', summary: longSummary } as any);
  assert.equal(typeof entry.ts, 'string');
  assert.ok(entry.ts.length > 0);
  assert.equal(entry.summary.length, 500);
  assert.deepEqual(entry.txSigs, []);

  // A short summary is unchanged.
  const short = appendJournal({ kind: 'tick', summary: 'short' } as any);
  assert.equal(short.summary, 'short');

  // Order is preserved.
  const journal = getState().journal;
  assert.equal(journal.length, 2);
  assert.equal(journal[0].summary.length, 500);
  assert.equal(journal[1].summary, 'short');
});

// ---------------------------------------------------------------------------
// 9. Journal cap at JOURNAL_MAX_ENTRIES (20)
// ---------------------------------------------------------------------------

test('journal is capped at JOURNAL_MAX_ENTRIES (20), oldest discarded', async () => {
  const { appendJournal, getState, JOURNAL_MAX_ENTRIES } = await loadStateFresh();
  assert.equal(JOURNAL_MAX_ENTRIES, 20);
  for (let i = 0; i < 25; i++) {
    appendJournal({ kind: 'tick', summary: `entry-${i}` } as any);
  }
  const journal = getState().journal;
  assert.equal(journal.length, 20);
  // Oldest 5 (entry-0 .. entry-4) should be gone; first remaining is entry-5.
  assert.equal(journal[0].summary, 'entry-5');
  assert.equal(journal[19].summary, 'entry-24');
});

// ---------------------------------------------------------------------------
// 10. setPaused — sets flag, journals pause/unpause, idempotent
// ---------------------------------------------------------------------------

test('setPaused toggles flag, appends journal entry, idempotent on no-op', async () => {
  const { setPaused, getState } = await loadStateFresh();

  setPaused(true, 'manual stop');
  let s = getState();
  assert.equal(s.paused, true);
  assert.equal(s.journal.length, 1);
  assert.equal(s.journal[0].kind, 'pause');
  assert.equal(s.journal[0].summary, 'manual stop');

  // Calling with the same value is a no-op — no extra journal entry.
  setPaused(true, 'still paused');
  s = getState();
  assert.equal(s.journal.length, 1);

  setPaused(false, 'resumed');
  s = getState();
  assert.equal(s.paused, false);
  assert.equal(s.journal.length, 2);
  assert.equal(s.journal[1].kind, 'unpause');
  assert.equal(s.journal[1].summary, 'resumed');

  setPaused(false);
  s = getState();
  assert.equal(s.journal.length, 2);
});

// ---------------------------------------------------------------------------
// 11. incrementErrorStreak — counts up; auto-pauses at threshold
// ---------------------------------------------------------------------------

test('incrementErrorStreak auto-pauses at threshold with pause-kind journal entry', async () => {
  const { incrementErrorStreak, getState, ERROR_STREAK_AUTO_PAUSE } = await loadStateFresh();
  assert.equal(ERROR_STREAK_AUTO_PAUSE, 3);

  assert.equal(incrementErrorStreak(), 1);
  assert.equal(getState().paused, false);

  assert.equal(incrementErrorStreak(), 2);
  assert.equal(getState().paused, false);

  // Hits the threshold — auto-pause kicks in.
  assert.equal(incrementErrorStreak(), 3);
  const s = getState();
  assert.equal(s.paused, true);
  assert.equal(s.errorStreak, 3);
  const pauseEntry = s.journal.find((j: any) => j.kind === 'pause');
  assert.ok(pauseEntry);
  assert.match(pauseEntry!.summary, /auto-paused/);
});

test('incrementErrorStreak does NOT double-pause if already paused', async () => {
  const { setPaused, incrementErrorStreak, getState } = await loadStateFresh();
  setPaused(true, 'manual'); // 1 journal entry, paused=true
  const before = getState().journal.length;
  // Reach threshold while already paused. Should not produce an extra pause entry.
  incrementErrorStreak();
  incrementErrorStreak();
  incrementErrorStreak();
  const after = getState().journal.length;
  assert.equal(after, before, 'no auto-pause journal entry when already paused');
  assert.equal(getState().paused, true);
});

// ---------------------------------------------------------------------------
// 12. resetErrorStreak — no-op when already 0 (does not rewrite the file)
// ---------------------------------------------------------------------------

test('resetErrorStreak zeros the counter and skips the write when already 0', async () => {
  const { incrementErrorStreak, resetErrorStreak, getState } = await loadStateFresh();
  incrementErrorStreak();
  incrementErrorStreak();
  assert.equal(getState().errorStreak, 2);

  resetErrorStreak();
  assert.equal(getState().errorStreak, 0);

  // Now already 0 — calling again must NOT rewrite the file.
  // We verify by snapshotting mtime, waiting a beat, and asserting equality.
  const mtimeBefore = statSync(stateFile()).mtimeMs;
  // Spin until at least 1ms has elapsed so a write would produce a new mtime.
  const start = Date.now();
  while (Date.now() - start < 5) {
    /* busy-wait briefly to ensure mtime granularity is exceeded */
  }
  resetErrorStreak();
  const mtimeAfter = statSync(stateFile()).mtimeMs;
  assert.equal(mtimeAfter, mtimeBefore, 'resetErrorStreak should not rewrite the file when streak is already 0');
});

// ---------------------------------------------------------------------------
// 13. setLastTickAt — writes value
// ---------------------------------------------------------------------------

test('setLastTickAt writes the timestamp to disk', async () => {
  const { setLastTickAt, getState } = await loadStateFresh();
  const ts = '2026-05-16T00:00:00.000Z';
  setLastTickAt(ts);
  assert.equal(getState().lastTickAt, ts);
  const onDisk = JSON.parse(readFileSync(stateFile(), 'utf-8'));
  assert.equal(onDisk.lastTickAt, ts);
});

// ---------------------------------------------------------------------------
// 14. Corrupted JSON → silent default fallback (does NOT throw)
// ---------------------------------------------------------------------------

test('getState silently returns defaults when agent-state.json is corrupted', async () => {
  // Write garbage that JSON.parse can't handle.
  writeFileSync(stateFile(), '{not valid json,,,');
  const { getState } = await loadStateFresh();
  // Should not throw; should fall back to defaults.
  const s = getState();
  assert.deepEqual(s.goals, []);
  assert.deepEqual(s.tasks, []);
  assert.deepEqual(s.journal, []);
  assert.equal(s.paused, false);
  assert.equal(s.errorStreak, 0);
  assert.equal(s.lastTickAt, null);
});

// ---------------------------------------------------------------------------
// 15. Malformed field shapes → per-field default fallback
// ---------------------------------------------------------------------------

test('getState replaces malformed field shapes with defaults', async () => {
  // Valid JSON, but wrong shapes for goals (string) and paused (string).
  writeFileSync(
    stateFile(),
    JSON.stringify({
      goals: 'not-an-array',
      tasks: { obj: 'instead-of-array' },
      journal: 42,
      paused: 'yes',
      errorStreak: 'three',
      lastTickAt: 12345,
      agentAssetAddress: 99, // wrong type — should fall back to undefined
    }),
  );
  const { getState } = await loadStateFresh();
  const s = getState();
  assert.deepEqual(s.goals, []);
  assert.deepEqual(s.tasks, []);
  assert.deepEqual(s.journal, []);
  assert.equal(s.paused, false);
  assert.equal(s.errorStreak, 0);
  assert.equal(s.lastTickAt, null);
  assert.equal(s.agentAssetAddress, undefined);
});
