import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { WalletRateLimiter } from '../src/wallet-rate-limit.js';

test('WalletRateLimiter allows up to max events in window', () => {
  let now = 0;
  const rl = new WalletRateLimiter({ max: 3, windowMs: 1000, maxKeys: 100, now: () => now });
  assert.equal(rl.allow('pk1'), true);
  assert.equal(rl.allow('pk1'), true);
  assert.equal(rl.allow('pk1'), true);
  assert.equal(rl.allow('pk1'), false);
});

test('WalletRateLimiter window slides forward', () => {
  let now = 0;
  const rl = new WalletRateLimiter({ max: 2, windowMs: 1000, maxKeys: 100, now: () => now });
  rl.allow('pk1');
  rl.allow('pk1');
  assert.equal(rl.allow('pk1'), false);
  now = 1500;
  assert.equal(rl.allow('pk1'), true);
});

test('WalletRateLimiter owner exemption never blocks the owner', () => {
  let now = 0;
  const rl = new WalletRateLimiter({
    max: 1,
    windowMs: 1000,
    maxKeys: 100,
    now: () => now,
    ownerExempt: 'OWNER',
  });
  for (let i = 0; i < 10; i++) {
    assert.equal(rl.allow('OWNER'), true);
  }
  // Non-owners still get the normal max=1 budget.
  assert.equal(rl.allow('other'), true);
  assert.equal(rl.allow('other'), false);
});

test('WalletRateLimiter LRU eviction directly resets the evicted entry', () => {
  // Saturate 'a' at the cap so its `allow()` would return false until evicted.
  // Then push 'b' and 'c' to overflow capacity, forcing 'a' out (oldest by
  // insertion order). Re-adding 'a' must succeed — proving the limiter
  // genuinely treats 'a' as fresh after eviction, not just tolerating it
  // because of a generous max.
  let now = 0;
  const rl = new WalletRateLimiter({ max: 1, windowMs: 1000, maxKeys: 2, now: () => now });
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), false); // saturated
  assert.equal(rl.allow('b'), true);
  assert.equal(rl.allow('c'), true); // evicts 'a' (size was 2, maxKeys 2)
  assert.equal(rl.size(), 2);
  assert.equal(rl.allow('a'), true); // fresh budget — proves eviction
});

test('WalletRateLimiter LRU eviction bounds memory under flood', () => {
  let now = 0;
  const rl = new WalletRateLimiter({ max: 5, windowMs: 1000, maxKeys: 3, now: () => now });
  rl.allow('a');
  rl.allow('b');
  rl.allow('c');
  rl.allow('d'); // forces eviction of 'a' (least-recently-used)
  assert.equal(rl.size(), 3);
  // Verify 'a' is the one that got evicted: re-adding it should bring the
  // map to size 4 ... no wait, capacity is 3 so adding 'a' would evict 'b'.
  // We confirm 'a' was evicted by checking it has no surviving timestamps:
  // its first allow() after eviction should succeed (fresh window, max=5).
  // To make this assertion meaningful without coupling to internal state, we
  // exhaust 'a's budget under a higher max — instead, just confirm that 'b'
  // (which should still be present) retains its prior timestamp by hitting
  // the cap. 'b' had 1 prior allow; it can take 4 more before saturating.
  for (let i = 0; i < 4; i++) {
    assert.equal(rl.allow('b'), true);
  }
  assert.equal(rl.allow('b'), false); // 5 total: 1 prior + 4 now
});

test('WalletRateLimiter setOwnerExempt updates exemption at runtime', () => {
  let now = 0;
  const rl = new WalletRateLimiter({ max: 1, windowMs: 1000, maxKeys: 100, now: () => now });
  // Without exemption, OWNER hits the max=1 cap.
  assert.equal(rl.allow('OWNER'), true);
  assert.equal(rl.allow('OWNER'), false);
  // After setting exemption, OWNER is unconditionally allowed.
  rl.setOwnerExempt('OWNER');
  for (let i = 0; i < 5; i++) {
    assert.equal(rl.allow('OWNER'), true);
  }
  // Clearing exemption restores the cap (window has not slid, prior calls
  // were exempt and didn't add timestamps, so OWNER's prior 2 timestamps
  // remain — already at max).
  rl.setOwnerExempt(null);
  assert.equal(rl.allow('OWNER'), false);
});
