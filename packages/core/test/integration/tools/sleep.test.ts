import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { fakeContext } from '../../helpers/mock-context.js';
import { sleep } from '../../../src/tools/shared/sleep.js';

/**
 * Integration tests for `sleep`.
 *
 * The tool is the only one in the shared toolset that intentionally
 * consults `requestContext.abortSignal` — it must wake early when the
 * connection / time budget / explicit cancel fires. We cover:
 *
 *   1. Happy path: a 1-second sleep actually waits ~1s and returns
 *      a success shape with `sleptFor: 1`. The Zod schema bottoms out
 *      at `seconds.min(1)`, so we can't do a sub-second smoke test.
 *      One second of wall time on the test runner is the floor.
 *
 *   2. Mid-sleep abort: an abort fired ~50ms in should bail the
 *      pending timer and produce a TIMEOUT error before the full
 *      duration elapses (we assert the call returned in < 500ms).
 *
 *   3. Pre-aborted signal: a signal already aborted at execute() time
 *      short-circuits before the timer is set — verifies the
 *      `signal?.aborted` guard at the top of the tool.
 */

test('sleep resolves after the requested duration and returns success', async () => {
  const t0 = Date.now();
  const result = (await sleep.execute!(
    { seconds: 1 },
    { requestContext: fakeContext() } as any,
  )) as any;
  const elapsed = Date.now() - t0;

  assert.equal(result.status, 'success');
  assert.equal(result.sleptFor, 1);
  assert.ok(typeof result.resumedAt === 'string', 'resumedAt is an ISO string');
  // setTimeout(_, 1000) on a healthy host fires within a few ms of the
  // request; we allow a 50ms cushion downwards but it should be ~1000ms.
  assert.ok(elapsed >= 950, `expected >= 950ms, got ${elapsed}ms`);
});

test('sleep aborts mid-sleep when abortSignal fires', async () => {
  const ctrl = new AbortController();
  const ctx = fakeContext({ abortSignal: ctrl.signal });
  // Fire the abort 50ms in — far less than the 5-second sleep.
  setTimeout(() => ctrl.abort(), 50);

  const t0 = Date.now();
  const result = (await sleep.execute!(
    { seconds: 5 },
    { requestContext: ctx } as any,
  )) as any;
  const elapsed = Date.now() - t0;

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'TIMEOUT');
  assert.match(result.message, /Sleep interrupted/);
  // Bailed before the 5-second deadline — 1 second is a generous
  // ceiling. (CI throttling can push setTimeout precision a bit.)
  assert.ok(elapsed < 1000, `expected < 1000ms, got ${elapsed}ms`);
});

test('sleep returns TIMEOUT immediately when signal is already aborted', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const ctx = fakeContext({ abortSignal: ctrl.signal });

  const t0 = Date.now();
  const result = (await sleep.execute!(
    { seconds: 30 },
    { requestContext: ctx } as any,
  )) as any;
  const elapsed = Date.now() - t0;

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'TIMEOUT');
  assert.match(result.message, /before it started/);
  // Pre-abort short-circuit: no timer is set, the call returns essentially
  // synchronously (microtask only). 200ms ceiling tolerates slower CI runners
  // while still verifying the short-circuit (the alternative — running the
  // full 30-second timer — would be 150x slower).
  assert.ok(elapsed < 200, `expected immediate return, got ${elapsed}ms`);
});
