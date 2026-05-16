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
import { setPausedTool } from '../../../src/tools/autonomous/set-paused.js';

/**
 * Integration tests for the `set-paused` autonomous tool.
 *
 * set-paused is a tiny shim over `setPaused` from
 * `@metaplex-foundation/shared`. It mutates `agent-state.json`.
 *
 * State path is cached in the shared `state.ts` module on first read, so we
 * use a single per-FILE tmpDir (set up in `before`) rather than per-test.
 * Each test resets state by unlinking the file in `beforeEach`. Worker-process
 * isolation between *.test.ts files means this caching does not leak between
 * files.
 */

const AGENT_KEYPAIR = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));

let tmpDir: string;
let originalCwd: string;

before(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'set-paused-test-'));
  writeFileSync(join(tmpDir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  process.chdir(tmpDir);
});

after(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset state file between tests so each starts from defaults.
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

function stateFile() {
  return join(tmpDir, 'agent-state.json');
}

test('set-paused pauses the worker and writes a pause journal entry', async () => {
  const result = (await setPausedTool.execute!(
    { paused: true, reason: 'manual stop' },
    { requestContext: {} } as any,
  )) as any;

  assert.equal(result.status, 'success');
  assert.equal(result.paused, true);
  assert.match(result.message, /paused/);

  assert.equal(existsSync(stateFile()), true);
  const onDisk = JSON.parse(readFileSync(stateFile(), 'utf-8'));
  assert.equal(onDisk.paused, true);
  assert.equal(onDisk.journal.length, 1);
  assert.equal(onDisk.journal[0].kind, 'pause');
  assert.equal(onDisk.journal[0].summary, 'manual stop');
});

test('set-paused unpauses after a previous pause and writes an unpause entry', async () => {
  await setPausedTool.execute!(
    { paused: true, reason: 'first pause' },
    { requestContext: {} } as any,
  );
  const result = (await setPausedTool.execute!(
    { paused: false, reason: 'back online' },
    { requestContext: {} } as any,
  )) as any;

  assert.equal(result.status, 'success');
  assert.equal(result.paused, false);
  assert.match(result.message, /resumed/);

  const onDisk = JSON.parse(readFileSync(stateFile(), 'utf-8'));
  assert.equal(onDisk.paused, false);
  assert.equal(onDisk.journal.length, 2);
  assert.equal(onDisk.journal[1].kind, 'unpause');
  assert.equal(onDisk.journal[1].summary, 'back online');
});

test('set-paused is idempotent: pause-pause writes only one journal entry', async () => {
  await setPausedTool.execute!(
    { paused: true, reason: 'one' },
    { requestContext: {} } as any,
  );
  await setPausedTool.execute!(
    { paused: true, reason: 'two' },
    { requestContext: {} } as any,
  );

  const onDisk = JSON.parse(readFileSync(stateFile(), 'utf-8'));
  assert.equal(onDisk.paused, true);
  assert.equal(onDisk.journal.length, 1, 'second pause-while-paused must not append');
});

test('set-paused rejects non-boolean paused via Zod', async () => {
  const result = (await setPausedTool.execute!(
    { paused: 'yes' } as any,
    { requestContext: {} } as any,
  )) as any;

  assert.equal(result.error, true);
});

test('set-paused rejects oversize reason via Zod (>300 chars)', async () => {
  const result = (await setPausedTool.execute!(
    { paused: true, reason: 'x'.repeat(301) } as any,
    { requestContext: {} } as any,
  )) as any;

  assert.equal(result.error, true);
});
