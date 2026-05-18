import { test, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import nacl from 'tweetnacl';
import {
  isolateEnv,
  restoreEnv,
  defaultTestEnv,
} from '../../../../shared/test/helpers/env.js';
import {
  setGoal,
  closeGoalTool,
  addTaskTool,
  closeTaskTool,
} from '../../../src/tools/autonomous/goals-tasks.js';

/**
 * Integration tests for the autonomous goals-tasks toolset.
 *
 * Four sub-tools live in one file: set-goal, close-goal, add-task,
 * close-task. They all mutate `agent-state.json` via the shared state
 * module, so we share one tmpDir per file (state.ts caches its path on
 * first call) and reset the file between tests.
 *
 * Each sub-tool gets at least:
 *   - One happy path that confirms the on-disk state change.
 *   - One Zod or NOT_FOUND error path.
 */

const AGENT_KEYPAIR = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));

let tmpDir: string;
let originalCwd: string;

before(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'goals-tasks-test-'));
  writeFileSync(join(tmpDir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  process.chdir(tmpDir);
});

after(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  const f = join(tmpDir, 'agent-state.json');
  if (existsSync(f)) unlinkSync(f);
  isolateEnv(
    defaultTestEnv({
      AGENT_MODE: 'autonomous',
      BOOTSTRAP_WALLET: 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2',
      AGENT_KEYPAIR,
    }),
  );
});

afterEach(() => {
  restoreEnv();
});

function readState() {
  return JSON.parse(readFileSync(join(tmpDir, 'agent-state.json'), 'utf-8'));
}

// ---------------------------------------------------------------------------
// set-goal
// ---------------------------------------------------------------------------

test('set-goal persists an active goal and writes a goal_set journal entry', async () => {
  const result = (await setGoal.execute!(
    { description: 'rebalance the treasury' },
    { requestContext: {} } as any,
  )) as any;

  assert.equal(result.status, 'success');
  assert.match(result.goalId, /^g_/);
  assert.equal(result.description, 'rebalance the treasury');

  const state = readState();
  assert.equal(state.goals.length, 1);
  assert.equal(state.goals[0].status, 'active');
  assert.equal(state.goals[0].description, 'rebalance the treasury');
  // Journal entry mirrors the goal_set.
  const journal = state.journal;
  assert.ok(journal.some((j: any) => j.kind === 'goal_set' && /rebalance/.test(j.summary)));
});

test('set-goal rejects empty description via Zod', async () => {
  const result = (await setGoal.execute!(
    { description: '' } as any,
    { requestContext: {} } as any,
  )) as any;

  assert.equal(result.error, true);
});

test('set-goal rejects oversize description (>500 chars) via Zod', async () => {
  const result = (await setGoal.execute!(
    { description: 'x'.repeat(501) } as any,
    { requestContext: {} } as any,
  )) as any;

  assert.equal(result.error, true);
});

// ---------------------------------------------------------------------------
// add-task
// ---------------------------------------------------------------------------

test('add-task creates an orphan task (no goalId) and persists it', async () => {
  const result = (await addTaskTool.execute!(
    { description: 'warm RPC cache' },
    { requestContext: {} } as any,
  )) as any;

  assert.equal(result.status, 'success');
  assert.match(result.taskId, /^t_/);
  assert.equal(result.goalId, null);

  const state = readState();
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].status, 'pending');
  assert.equal(state.tasks[0].goalId, null);
});

test('add-task links to an existing goal when goalId references a known goal', async () => {
  const goal = (await setGoal.execute!(
    { description: 'grow holders' },
    { requestContext: {} } as any,
  )) as any;

  const result = (await addTaskTool.execute!(
    { description: 'tweet about token', goalId: goal.goalId },
    { requestContext: {} } as any,
  )) as any;

  assert.equal(result.status, 'success');
  assert.equal(result.goalId, goal.goalId);

  const state = readState();
  const linked = state.tasks.find((t: any) => t.goalId === goal.goalId);
  assert.ok(linked);
});

test('add-task rejects with NOT_FOUND when goalId references a missing goal', async () => {
  const result = (await addTaskTool.execute!(
    { description: 'orphan link', goalId: 'g_doesnotexist' },
    { requestContext: {} } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'NOT_FOUND');
  assert.match(result.message, /No goal found/);
});

test('add-task rejects empty description via Zod', async () => {
  const result = (await addTaskTool.execute!(
    { description: '' } as any,
    { requestContext: {} } as any,
  )) as any;

  assert.equal(result.error, true);
});

// ---------------------------------------------------------------------------
// close-task
// ---------------------------------------------------------------------------

test('close-task marks a task done and records the result', async () => {
  const created = (await addTaskTool.execute!(
    { description: 'mint asset' },
    { requestContext: {} } as any,
  )) as any;

  const result = (await closeTaskTool.execute!(
    { taskId: created.taskId, status: 'done', result: 'sig: abc' },
    { requestContext: {} } as any,
  )) as any;

  assert.equal(result.status, 'success');
  assert.equal(result.finalStatus, 'done');

  const state = readState();
  const t = state.tasks.find((x: any) => x.id === created.taskId);
  assert.equal(t.status, 'done');
  assert.equal(t.result, 'sig: abc');
});

test('close-task returns info (not error) when marking a task failed', async () => {
  const created = (await addTaskTool.execute!(
    { description: 'risky op' },
    { requestContext: {} } as any,
  )) as any;

  const result = (await closeTaskTool.execute!(
    { taskId: created.taskId, status: 'failed', result: 'rpc timeout' },
    { requestContext: {} } as any,
  )) as any;

  // failed is a 'info'-shaped return so the agent doesn't double-count it
  // as a hard error.
  assert.equal(result.status, 'info');
  assert.equal(result.finalStatus, 'failed');
});

test('close-task returns NOT_FOUND for unknown taskId', async () => {
  const result = (await closeTaskTool.execute!(
    { taskId: 't_missing', status: 'done', result: 'nope' },
    { requestContext: {} } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'NOT_FOUND');
});

test('close-task rejects unknown status via Zod', async () => {
  const result = (await closeTaskTool.execute!(
    { taskId: 't_abc', status: 'maybe', result: 'meh' } as any,
    { requestContext: {} } as any,
  )) as any;

  assert.equal(result.error, true);
});

// ---------------------------------------------------------------------------
// close-goal
// ---------------------------------------------------------------------------

test('close-goal marks a goal achieved and appends a journal entry when reason is given', async () => {
  const goal = (await setGoal.execute!(
    { description: 'be excellent' },
    { requestContext: {} } as any,
  )) as any;

  const beforeJournalLen = readState().journal.length;

  const result = (await closeGoalTool.execute!(
    { goalId: goal.goalId, status: 'achieved', reason: 'shipped feature' },
    { requestContext: {} } as any,
  )) as any;

  assert.equal(result.status, 'success');
  assert.equal(result.finalStatus, 'achieved');

  const state = readState();
  const g = state.goals.find((x: any) => x.id === goal.goalId);
  assert.equal(g.status, 'achieved');
  assert.equal(
    state.journal.length,
    beforeJournalLen + 1,
    'closing with a reason should append exactly one journal entry',
  );
});

test('close-goal accepts abandoned status and works without a reason', async () => {
  const goal = (await setGoal.execute!(
    { description: 'experimental work' },
    { requestContext: {} } as any,
  )) as any;

  const beforeJournalLen = readState().journal.length;

  const result = (await closeGoalTool.execute!(
    { goalId: goal.goalId, status: 'abandoned' },
    { requestContext: {} } as any,
  )) as any;

  assert.equal(result.status, 'success');
  assert.equal(result.finalStatus, 'abandoned');

  // No reason means no extra journal entry beyond the original goal_set.
  assert.equal(readState().journal.length, beforeJournalLen);
});

test('close-goal returns NOT_FOUND for unknown goalId', async () => {
  const result = (await closeGoalTool.execute!(
    { goalId: 'g_missing', status: 'achieved' },
    { requestContext: {} } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'NOT_FOUND');
});

test('close-goal rejects unknown status via Zod', async () => {
  const result = (await closeGoalTool.execute!(
    { goalId: 'g_abc', status: 'cancelled' } as any,
    { requestContext: {} } as any,
  )) as any;

  assert.equal(result.error, true);
});
