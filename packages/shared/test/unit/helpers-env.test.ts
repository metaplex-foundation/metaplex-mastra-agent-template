import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isolateEnv, restoreEnv, defaultTestEnv } from '../helpers/env.js';

test('isolateEnv replaces env, restoreEnv restores it', () => {
  process.env.PRE_EXISTING = 'original';
  isolateEnv({ NEW_VAR: 'hello' });
  assert.equal(process.env.NEW_VAR, 'hello');
  assert.equal(process.env.PRE_EXISTING, undefined);
  restoreEnv();
  assert.equal(process.env.PRE_EXISTING, 'original');
  assert.equal(process.env.NEW_VAR, undefined);
  delete process.env.PRE_EXISTING;
});

test('defaultTestEnv merges overrides', () => {
  const env = defaultTestEnv({ FOO: 'bar' });
  assert.equal(env.AGENT_MODE, 'public');
  assert.equal(env.FOO, 'bar');
});
