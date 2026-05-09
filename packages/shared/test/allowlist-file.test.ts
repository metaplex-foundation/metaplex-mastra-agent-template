import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AllowlistFile } from '../src/allowlist-file.js';

const tmpDirs: string[] = [];

function tmpFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'allowlist-'));
  tmpDirs.push(dir);
  const p = join(dir, 'wallets.allowlist.json');
  writeFileSync(p, contents);
  return p;
}

test.after(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

test('AllowlistFile.load returns wallets from valid file', () => {
  const p = tmpFile(JSON.stringify({ wallets: ['pk1', 'pk2'] }));
  const f = new AllowlistFile({ path: p, envFallback: [] });
  assert.deepEqual(f.current(), ['pk1', 'pk2']);
});

test('AllowlistFile merges file + env, deduped', () => {
  const p = tmpFile(JSON.stringify({ wallets: ['pk1', 'pk2'] }));
  const f = new AllowlistFile({ path: p, envFallback: ['pk2', 'pk3'] });
  assert.deepEqual([...f.current()].sort(), ['pk1', 'pk2', 'pk3']);
});

test('AllowlistFile falls back to env when file missing', () => {
  const f = new AllowlistFile({ path: '/nonexistent/path.json', envFallback: ['pk1'] });
  assert.deepEqual(f.current(), ['pk1']);
});

test('AllowlistFile keeps last good list on malformed JSON', () => {
  const p = tmpFile(JSON.stringify({ wallets: ['pk1'] }));
  const f = new AllowlistFile({ path: p, envFallback: [] });
  assert.deepEqual(f.current(), ['pk1']);
  writeFileSync(p, '{not valid json');
  f.reload();
  assert.deepEqual(f.current(), ['pk1']); // unchanged
});

test('AllowlistFile uses envFallback when first construction sees malformed JSON', () => {
  // No prior snapshot to preserve, so the env-supplied list must still be
  // honored — otherwise a typo'd JSON file silently blanks the allowlist.
  const p = tmpFile('{not valid json');
  const f = new AllowlistFile({ path: p, envFallback: ['env-pk1', 'env-pk2'] });
  assert.deepEqual([...f.current()].sort(), ['env-pk1', 'env-pk2']);
});

test('AllowlistFile yields empty list when first construction sees malformed JSON and empty env', () => {
  const p = tmpFile('{not valid json');
  const f = new AllowlistFile({ path: p, envFallback: [] });
  assert.deepEqual(f.current(), []);
});

test('AllowlistFile reload picks up file changes', () => {
  const p = tmpFile(JSON.stringify({ wallets: ['pk1'] }));
  const f = new AllowlistFile({ path: p, envFallback: [] });
  assert.deepEqual(f.current(), ['pk1']);
  writeFileSync(p, JSON.stringify({ wallets: ['pk1', 'pk2'] }));
  f.reload();
  assert.deepEqual([...f.current()].sort(), ['pk1', 'pk2']);
});

test('AllowlistFile.current() returns a frozen array (no runtime mutation)', () => {
  const p = tmpFile(JSON.stringify({ wallets: ['pk1'] }));
  const f = new AllowlistFile({ path: p, envFallback: [] });
  const list = f.current() as string[];
  assert.throws(() => list.push('attacker'), /not extensible|Cannot add/);
  assert.deepEqual(f.current(), ['pk1']);
});

test('AllowlistFile drops file entries after the file is deleted', () => {
  const p = tmpFile(JSON.stringify({ wallets: ['pk1'] }));
  const f = new AllowlistFile({ path: p, envFallback: ['pk2'] });
  assert.deepEqual([...f.current()].sort(), ['pk1', 'pk2']);
  rmSync(dirname(p), { recursive: true, force: true });
  f.reload();
  assert.deepEqual(f.current(), ['pk2']);
});

// --- Mutation API (Sprint 2 #20: owner-only allowlist admin) ---

test('AllowlistFile.addWallet appends and persists', () => {
  const p = tmpFile(JSON.stringify({ wallets: ['pk1'] }));
  const f = new AllowlistFile({ path: p, envFallback: [] });
  const added = f.addWallet('pk2');
  assert.equal(added, true);
  assert.deepEqual([...f.current()].sort(), ['pk1', 'pk2']);
  // Re-construct from disk to confirm it was actually written, not just held in-memory.
  const f2 = new AllowlistFile({ path: p, envFallback: [] });
  assert.deepEqual([...f2.current()].sort(), ['pk1', 'pk2']);
});

test('AllowlistFile.addWallet is idempotent on duplicates', () => {
  const p = tmpFile(JSON.stringify({ wallets: ['pk1'] }));
  const f = new AllowlistFile({ path: p, envFallback: [] });
  const added = f.addWallet('pk1');
  assert.equal(added, false);
  assert.deepEqual(f.current(), ['pk1']);
});

test('AllowlistFile.addWallet trims whitespace before storing', () => {
  const p = tmpFile(JSON.stringify({ wallets: [] }));
  const f = new AllowlistFile({ path: p, envFallback: [] });
  f.addWallet('  pk-trimmed  ');
  assert.deepEqual(f.current(), ['pk-trimmed']);
});

test('AllowlistFile.addWallet refuses empty input', () => {
  const p = tmpFile(JSON.stringify({ wallets: [] }));
  const f = new AllowlistFile({ path: p, envFallback: [] });
  assert.equal(f.addWallet(''), false);
  assert.equal(f.addWallet('   '), false);
  assert.deepEqual(f.current(), []);
});

test('AllowlistFile.removeWallet removes and persists', () => {
  const p = tmpFile(JSON.stringify({ wallets: ['pk1', 'pk2', 'pk3'] }));
  const f = new AllowlistFile({ path: p, envFallback: [] });
  const removed = f.removeWallet('pk2');
  assert.equal(removed, true);
  assert.deepEqual([...f.current()].sort(), ['pk1', 'pk3']);
  const f2 = new AllowlistFile({ path: p, envFallback: [] });
  assert.deepEqual([...f2.current()].sort(), ['pk1', 'pk3']);
});

test('AllowlistFile.removeWallet is idempotent on missing entries', () => {
  const p = tmpFile(JSON.stringify({ wallets: ['pk1'] }));
  const f = new AllowlistFile({ path: p, envFallback: [] });
  const removed = f.removeWallet('pk-not-there');
  assert.equal(removed, false);
  assert.deepEqual(f.current(), ['pk1']);
});

test('AllowlistFile.fileWallets / envWallets distinguish sources', () => {
  const p = tmpFile(JSON.stringify({ wallets: ['file-pk'] }));
  const f = new AllowlistFile({ path: p, envFallback: ['env-pk'] });
  assert.deepEqual([...f.fileWallets()], ['file-pk']);
  assert.deepEqual([...f.envWallets], ['env-pk']);
});

test('AllowlistFile.removeWallet on env-supplied entry leaves env list intact (non-mutating)', () => {
  // Env entries are immutable from this API. The protocol layer rejects
  // env-source removes upstream; this test just confirms the file-level
  // call doesn't accidentally mutate envFallback when the entry happens
  // to also exist in the file.
  const p = tmpFile(JSON.stringify({ wallets: ['both-pk'] }));
  const f = new AllowlistFile({ path: p, envFallback: ['both-pk'] });
  f.removeWallet('both-pk');
  assert.deepEqual([...f.envWallets], ['both-pk']);
  // Merged view still shows the entry, sourced from env.
  assert.deepEqual([...f.current()], ['both-pk']);
});
