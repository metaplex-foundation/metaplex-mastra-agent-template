# Comprehensive Testing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a layered test suite (unit → integration → E2E) that catches regressions across every module, tool, WebSocket message type, and the autonomous worker loop. Wire it into CI with coverage thresholds.

**Architecture:** Keep `node --test` (already in use, zero new deps). Three test layers:
1. **Unit** — pure functions, deterministic, no I/O. Lives in `<pkg>/test/unit/*.test.ts`.
2. **Integration** — tool `execute()` paths, agent assembly, worker tick, with stubbed UMI/RPC/Mastra model. Lives in `<pkg>/test/integration/*.test.ts`.
3. **E2E** — real WebSocket server on ephemeral port, real `ws` client, mocked Solana RPC + mocked LLM. One full conversation per scenario. Lives in `packages/server/test/e2e/*.test.ts`.

Shared test helpers live in each package's `test/helpers/` directory (no new workspace package — keep dependency graph flat). A small mock-RPC HTTP server and a stub Mastra model are the load-bearing infrastructure pieces.

**Tech Stack:** `node:test`, `node:assert/strict`, native Node coverage (`--experimental-test-coverage` → `lcov`), `ws` (already a dep) for E2E clients, `nock` for HTTP mocking (Jupiter), in-process mock RPC server for Solana. No Jest, Vitest, Mocha, Playwright, or Cypress.

**Mocking boundaries** (anywhere the runtime crosses a network/disk boundary):
- Solana RPC (`SOLANA_RPC_URL`) → in-process HTTP mock server, fixtures per method
- Jupiter API (`api.jup.ag`) → `nock` interceptors
- Anthropic API (Mastra model) → stub `Agent.generate()` / `Agent.stream()` returning canned tool calls
- File I/O (`agent-state.json`, `wallets.allowlist.json`, `.env`) → `os.tmpdir()` per-test dirs
- Time (`setTimeout`, `Date.now`) → injected clock for worker loop

**Coverage target:** 80% line coverage across `packages/*/src/`, with hard floors enforced per package in CI.

**Out of scope (explicit non-goals):**
- Real Solana localnet / devnet integration in CI (too slow, flaky, key management complexity)
- Real Anthropic API calls in CI (cost, nondeterminism)
- Frontend (`metaplex-agent-chat-template`) tests — that's a sibling repo
- Load/perf testing — separate effort
- Persona-content tests beyond loader smoke (personas are prose, not logic)

---

## Phase 0 — Foundation

Wire up the runner, coverage, helpers, and CI before writing any new tests. Every later phase depends on this.

### Task 0.1: Add root `pnpm test` script

**Files:**
- Modify: `package.json:6-16` (scripts block)

**Step 1: Add scripts**

Add to root `package.json` scripts:
```json
"test": "pnpm --filter @metaplex-foundation/core... build && pnpm -r test",
"test:coverage": "pnpm --filter @metaplex-foundation/core... build && pnpm -r test:coverage",
"test:unit": "pnpm -r test:unit",
"test:integration": "pnpm --filter @metaplex-foundation/core... build && pnpm -r test:integration",
"test:e2e": "pnpm --filter @metaplex-foundation/server build && pnpm --filter @metaplex-foundation/server test:e2e"
```

**Step 2: Verify**

Run: `pnpm test`
Expected: PASS (existing 11 tests still green, just routed through root).

**Step 3: Commit**

```bash
git add package.json
git commit -m "test: add root aggregate test scripts"
```

---

### Task 0.2: Add per-package test scripts with coverage + layer split

**Files:**
- Modify: `packages/shared/package.json:9` (scripts.test)
- Modify: `packages/core/package.json:9`
- Modify: `packages/server/package.json:9`

**Step 1: Update each package.json**

Replace `"test": "node --test --import tsx"` with:
```json
"test": "node --test --import tsx --test-reporter spec 'test/**/*.test.ts'",
"test:unit": "node --test --import tsx --test-reporter spec 'test/unit/**/*.test.ts'",
"test:integration": "node --test --import tsx --test-reporter spec 'test/integration/**/*.test.ts'",
"test:coverage": "node --test --import tsx --experimental-test-coverage --test-coverage-include='src/**/*.ts' --test-coverage-exclude='src/**/*.d.ts' --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=coverage/lcov.info 'test/**/*.test.ts'"
```

For `packages/server/package.json` add additionally:
```json
"test:e2e": "node --test --import tsx --test-reporter spec --test-timeout=30000 'test/e2e/**/*.test.ts'"
```

**Step 2: Move existing tests into `unit/` subdirs**

Run:
```bash
mkdir -p packages/shared/test/unit packages/core/test/unit packages/server/test/unit
git mv packages/shared/test/siws.test.ts packages/shared/test/unit/siws.test.ts
git mv packages/shared/test/agent-config.test.ts packages/shared/test/unit/agent-config.test.ts
git mv packages/shared/test/allowlist.test.ts packages/shared/test/unit/allowlist.test.ts
git mv packages/shared/test/allowlist-file.test.ts packages/shared/test/unit/allowlist-file.test.ts
git mv packages/shared/test/config.test.ts packages/shared/test/unit/config.test.ts
git mv packages/shared/test/nonce-store.test.ts packages/shared/test/unit/nonce-store.test.ts
git mv packages/shared/test/paas.test.ts packages/shared/test/unit/paas.test.ts
git mv packages/shared/test/registration-banner.test.ts packages/shared/test/unit/registration-banner.test.ts
git mv packages/shared/test/wallet-rate-limit.test.ts packages/shared/test/unit/wallet-rate-limit.test.ts
git mv packages/core/test/personas.test.ts packages/core/test/unit/personas.test.ts
git mv packages/server/test/dashboard.test.ts packages/server/test/unit/dashboard.test.ts
```

**Step 3: Fix relative imports**

In each moved file, update `from '../src/...'` to `from '../../src/...'` (one level deeper). Use grep + sed or just open each and adjust.

Run: `pnpm test`
Expected: PASS — all 11 existing tests still green.

**Step 4: Commit**

```bash
git add packages/*/package.json packages/*/test
git commit -m "test: split tests by layer (unit/integration/e2e) and add coverage script"
```

---

### Task 0.3: Add `nock` and `@types/ws` to server devDeps

**Files:**
- Modify: `packages/server/package.json` (devDependencies)
- Modify: `packages/shared/package.json` (devDependencies — for jupiter tests)

**Step 1: Install**

```bash
pnpm --filter @metaplex-foundation/server add -D nock@^14.0.0
pnpm --filter @metaplex-foundation/shared add -D nock@^14.0.0
```

**Step 2: Verify install**

Run: `pnpm -r ls nock`
Expected: shows `nock 14.x` under both packages.

**Step 3: Commit**

```bash
git add packages/shared/package.json packages/server/package.json pnpm-lock.yaml
git commit -m "test: add nock for HTTP mocking"
```

---

### Task 0.4: Create shared test helpers — env scaffolding

**Files:**
- Create: `packages/shared/test/helpers/env.ts`

**Step 1: Write helper**

```typescript
// packages/shared/test/helpers/env.ts
export const ZERO_KEYPAIR = '[' + Array.from({ length: 64 }, () => 0).join(',') + ']';

const SAVED_ENV: Record<string, string | undefined> = {};

export function isolateEnv(overrides: Record<string, string> = {}): void {
  for (const k of Object.keys(process.env)) SAVED_ENV[k] = process.env[k];
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, overrides);
}

export function restoreEnv(): void {
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v !== undefined) process.env[k] = v;
  }
}

export function defaultTestEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    AGENT_MODE: 'public',
    AGENT_KEYPAIR: ZERO_KEYPAIR,
    SOLANA_RPC_URL: 'http://127.0.0.1:9999',
    ANTHROPIC_API_KEY: 'test-key',
    ...extra,
  };
}
```

**Step 2: Write a sanity test** at `packages/shared/test/unit/helpers-env.test.ts`:

```typescript
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
```

**Step 3: Run**

Run: `pnpm --filter @metaplex-foundation/shared test:unit`
Expected: PASS.

**Step 4: Refactor `dashboard.test.ts` and the env-handling parts of others to use these helpers** (optional cleanup — keep the original tests green).

**Step 5: Commit**

```bash
git add packages/shared/test/helpers/ packages/shared/test/unit/helpers-env.test.ts
git commit -m "test: add env isolation helpers"
```

---

### Task 0.5: Create mock Solana RPC server

**Files:**
- Create: `packages/shared/test/helpers/mock-rpc.ts`

**Step 1: Write helper**

```typescript
// packages/shared/test/helpers/mock-rpc.ts
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

type RpcHandler = (params: unknown[]) => unknown;

export interface MockRpc {
  url: string;
  on(method: string, handler: RpcHandler): void;
  calls: { method: string; params: unknown[] }[];
  close(): Promise<void>;
}

export async function startMockRpc(): Promise<MockRpc> {
  const handlers = new Map<string, RpcHandler>();
  const calls: { method: string; params: unknown[] }[] = [];

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      calls.push({ method, params });
      const handler = handlers.get(method);
      if (!handler) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `no handler for ${method}` } }));
        return;
      }
      try {
        const result = handler(params ?? []);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: (e as Error).message } }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    on(method, handler) { handlers.set(method, handler); },
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Common fixture: standard `getLatestBlockhash` response
export function blockhashFixture() {
  return {
    context: { slot: 1 },
    value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 },
  };
}
```

**Step 2: Smoke test** at `packages/shared/test/unit/helpers-mock-rpc.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { startMockRpc, blockhashFixture } from '../helpers/mock-rpc.js';

test('mock RPC routes by method and records calls', async () => {
  const rpc = await startMockRpc();
  rpc.on('getLatestBlockhash', () => blockhashFixture());

  const res = await fetch(rpc.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] }),
  });
  const body = await res.json();
  assert.equal(body.result.value.blockhash, '11111111111111111111111111111111');
  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].method, 'getLatestBlockhash');

  await rpc.close();
});

test('mock RPC returns JSON-RPC error for unhandled methods', async () => {
  const rpc = await startMockRpc();
  const res = await fetch(rpc.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSomethingMissing', params: [] }),
  });
  const body = await res.json();
  assert.equal(body.error.code, -32601);
  await rpc.close();
});
```

**Step 3: Run**

Run: `pnpm --filter @metaplex-foundation/shared test:unit`
Expected: PASS.

**Step 4: Commit**

```bash
git add packages/shared/test/helpers/mock-rpc.ts packages/shared/test/unit/helpers-mock-rpc.test.ts
git commit -m "test: add in-process Solana RPC mock"
```

---

### Task 0.6: Create stub Mastra model + fake RequestContext

**Files:**
- Create: `packages/core/test/helpers/mock-agent.ts`
- Create: `packages/core/test/helpers/mock-context.ts`

**Step 1: Write `mock-context.ts`**

```typescript
// packages/core/test/helpers/mock-context.ts
import { RequestContext } from '@mastra/core/request-context';

export interface FakeContextOpts {
  walletAddress?: string;
  agentMode?: 'public' | 'autonomous';
  agentAssetAddress?: string | null;
  agentTokenMint?: string | null;
  agentFeeSol?: number;
  tokenOverride?: string;
  ownerWallet?: string;
  transactionSender?: (b64: string) => Promise<string>;
  abortSignal?: AbortSignal;
  txCounter?: { count: number; max: number };
}

export function fakeContext(opts: FakeContextOpts = {}): RequestContext {
  const entries: [string, unknown][] = [
    ['walletAddress', opts.walletAddress ?? 'OwnerWalletAddressPlaceholder1111111111111'],
    ['agentMode', opts.agentMode ?? 'public'],
    ['agentAssetAddress', opts.agentAssetAddress ?? null],
    ['agentTokenMint', opts.agentTokenMint ?? null],
    ['agentFeeSol', opts.agentFeeSol ?? 0],
    ['tokenOverride', opts.tokenOverride ?? null],
    ['ownerWallet', opts.ownerWallet ?? 'OwnerWalletAddressPlaceholder1111111111111'],
    ['abortSignal', opts.abortSignal ?? new AbortController().signal],
  ];
  if (opts.transactionSender) entries.push(['transactionSender', opts.transactionSender]);
  if (opts.txCounter) entries.push(['txCounter', opts.txCounter]);
  return new RequestContext(entries);
}
```

**Step 2: Write `mock-agent.ts`** — a stub model that replays a scripted sequence of tool calls.

```typescript
// packages/core/test/helpers/mock-agent.ts
export type ScriptedStep =
  | { type: 'tool-call'; toolName: string; args: unknown }
  | { type: 'text'; content: string };

export interface StubAgent {
  generate: (input: unknown, opts?: unknown) => Promise<{ text: string; toolCalls: { toolName: string; args: unknown; result: unknown }[] }>;
  setScript: (steps: ScriptedStep[]) => void;
  toolResults: Map<string, unknown>;
}

export function makeStubAgent(tools: Record<string, { execute: (args: unknown, ctx: { requestContext: unknown }) => Promise<unknown> }>): StubAgent {
  let script: ScriptedStep[] = [];
  const toolResults = new Map<string, unknown>();

  return {
    generate: async (_input, opts: any) => {
      const ctx = opts?.requestContext;
      const toolCalls: { toolName: string; args: unknown; result: unknown }[] = [];
      let text = '';
      for (const step of script) {
        if (step.type === 'text') {
          text += step.content;
        } else {
          const tool = tools[step.toolName];
          if (!tool) throw new Error(`stub agent: tool ${step.toolName} not registered`);
          const result = await tool.execute(step.args, { requestContext: ctx });
          toolCalls.push({ toolName: step.toolName, args: step.args, result });
          toolResults.set(step.toolName, result);
        }
      }
      return { text, toolCalls };
    },
    setScript(steps) { script = steps; },
    toolResults,
  };
}
```

**Step 3: Smoke test** at `packages/core/test/unit/helpers-mock-agent.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { makeStubAgent } from '../helpers/mock-agent.js';
import { fakeContext } from '../helpers/mock-context.js';

test('stub agent invokes scripted tools in order', async () => {
  const calls: string[] = [];
  const tools = {
    foo: { execute: async (args: any) => { calls.push(`foo(${args.x})`); return 'ok'; } },
    bar: { execute: async () => { calls.push('bar'); return 42; } },
  };
  const agent = makeStubAgent(tools);
  agent.setScript([
    { type: 'tool-call', toolName: 'foo', args: { x: 1 } },
    { type: 'text', content: 'between' },
    { type: 'tool-call', toolName: 'bar', args: {} },
  ]);

  const result = await agent.generate('prompt', { requestContext: fakeContext() });
  assert.deepEqual(calls, ['foo(1)', 'bar']);
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[1].result, 42);
  assert.equal(result.text, 'between');
});
```

**Step 4: Run**

Run: `pnpm --filter @metaplex-foundation/core test:unit`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/test/helpers/ packages/core/test/unit/helpers-mock-agent.test.ts
git commit -m "test: add stub Mastra agent and fake RequestContext helpers"
```

---

### Task 0.7: Wire CI to run tests + enforce coverage

**Files:**
- Modify: `.github/workflows/ci.yml`

**Step 1: Add steps after the Build step**

```yaml
      - name: Test
        run: pnpm test

      - name: Coverage
        run: pnpm test:coverage

      - name: Upload coverage
        uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: packages/*/coverage/lcov.info
          if-no-files-found: error
```

**Step 2: Add coverage-threshold gate** — create `scripts/check-coverage.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';

const MIN_LINES_PCT = 80;

async function check() {
  const files: string[] = [];
  for await (const f of glob('packages/*/coverage/lcov.info')) files.push(f);
  if (files.length === 0) {
    console.error('no lcov files found');
    process.exit(1);
  }
  let totalLines = 0;
  let coveredLines = 0;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const line of text.split('\n')) {
      if (line.startsWith('LF:')) totalLines += Number(line.slice(3));
      if (line.startsWith('LH:')) coveredLines += Number(line.slice(3));
    }
  }
  const pct = (coveredLines / totalLines) * 100;
  console.log(`Coverage: ${coveredLines}/${totalLines} lines (${pct.toFixed(2)}%)`);
  if (pct < MIN_LINES_PCT) {
    console.error(`Coverage ${pct.toFixed(2)}% below threshold ${MIN_LINES_PCT}%`);
    process.exit(1);
  }
}

check();
```

Add CI step:
```yaml
      - name: Enforce coverage threshold
        run: tsx scripts/check-coverage.ts
```

**Step 3: Set threshold low initially**

Set `MIN_LINES_PCT = 10` in `check-coverage.ts` so CI passes on first merge. Raise progressively per phase.

**Step 4: Verify locally**

Run: `pnpm test:coverage && tsx scripts/check-coverage.ts`
Expected: prints coverage %, exits 0.

**Step 5: Commit**

```bash
git add .github/workflows/ci.yml scripts/check-coverage.ts
git commit -m "ci: run tests and enforce coverage threshold"
```

---

## Phase 1 — Fill Shared Module Unit Gaps

Cover every `packages/shared/src/*.ts` that lacks meaningful coverage today. Pure functions and small classes — no I/O mocking needed except `nock` for `jupiter.ts`.

### Task 1.1: `state.ts` — goals/tasks/journal persistence

**Files:**
- Test: `packages/shared/test/unit/state.test.ts`
- Source: `packages/shared/src/state.ts`

**Step 1: Read the source** (`packages/shared/src/state.ts`) and list every exported function.

**Step 2: Write tests covering:**
- `loadState` / `saveState` round-trip via temp file (use `os.tmpdir()` + `fs.mkdtemp()`)
- `addGoal`, `closeGoal`, `addTask`, `closeTask` mutate immutably and persist
- `appendJournalEntry` caps history at the documented limit
- `incrementErrorStreak` triggers `paused: true` at 3 consecutive failures
- `resetErrorStreak` clears the counter
- Missing-file path: `loadState` returns default shape, doesn't throw
- Corrupted-file path: `loadState` throws a clear error, does NOT silently reset (would mask production bugs)

**Step 3: Run and commit**

```bash
pnpm --filter @metaplex-foundation/shared test:unit
git add packages/shared/test/unit/state.test.ts
git commit -m "test(shared): cover state.ts persistence and error streak"
```

---

### Task 1.2: `execute.ts` — Core Execute CPI wrapper

**Files:**
- Test: `packages/shared/test/unit/execute.test.ts`
- Source: `packages/shared/src/execute.ts`

**Step 1: Tests**
- `deriveAssetSignerPda` returns a valid PDA for known asset address (use a fixed asset key fixture)
- `wrapWithExecute` produces a transaction with the Execute instruction at index 0 and the wrapped instruction(s) after
- `submitOrSend` in `public` mode returns a base64-serialized tx and does NOT broadcast (assert mock RPC `sendTransaction` was never called)
- `submitOrSend` in `autonomous` mode calls `sendAndConfirm` on the mock RPC
- `submitOrSend` in autonomous dry-run mode returns a synthetic `DRYRUN_*` signature without calling RPC
- `submitOrSend` increments `TxCounter` and throws when the per-tick cap is exceeded

**Step 2: Build a UMI fixture helper** at `packages/shared/test/helpers/umi.ts` that creates a UMI instance pointed at the mock RPC URL.

**Step 3: Commit**

```bash
git add packages/shared/test/unit/execute.test.ts packages/shared/test/helpers/umi.ts
git commit -m "test(shared): cover Core Execute wrapper and tx routing"
```

---

### Task 1.3: `transaction.ts` — tx builder + TxCounter

**Files:**
- Test: `packages/shared/test/unit/transaction.test.ts`

**Step 1: Tests**
- TxCounter: starts at `0`, `inc()` increments, throws when count would exceed max
- `buildTransferSolIx` produces a SystemProgram transfer with correct lamports
- `buildTransferTokenIx` requires destination token account creation when ATA doesn't exist (mock the RPC `getAccountInfo` to return null)
- Multi-instruction batching respects the 1232-byte tx size limit

**Step 2: Commit**

---

### Task 1.4: `jupiter.ts` — Jupiter quote + swap

**Files:**
- Test: `packages/shared/test/unit/jupiter.test.ts`

**Step 1: Tests using `nock`**
- `getQuote` issues GET to `api.jup.ag/swap/v1/quote` with correct params (inputMint, outputMint, amount, slippageBps)
- `getQuote` propagates 4xx errors with a sanitized message
- `buildSwapTx` POSTs to `api.jup.ag/swap/v1/swap` with quoteResponse + userPublicKey + wrapUnwrapSol
- API key (if `JUPITER_API_KEY` set) goes into header
- Network error → throws typed error (assert error class/code, not just message)

**Step 2: Commit**

---

### Task 1.5: `auth.ts` — authorization tiers

**Files:**
- Test: `packages/shared/test/unit/auth.test.ts`

**Step 1: Tests**
- `isAuthorized('open', anyWallet)` → true
- `isAuthorized('owner', ownerWallet)` → true
- `isAuthorized('owner', strangerWallet)` → false
- `isAuthorized('allowlist', listedWallet)` → true (and owner is implicitly allowed)
- `isAuthorized('allowlist', strangerWallet)` → false
- 5-minute TTL cache: second call within 5 minutes does not re-query on-chain (assert via call counter on mock)
- Cache eviction: call after `>5 min` advances time and re-queries

**Step 2: Use injected clock pattern** — `auth.ts` may need a small refactor to accept a clock fn. If so, do that refactor in this task and adjust call sites.

**Step 3: Commit**

---

### Task 1.6: `funding.ts` — pre-op balance checks

**Files:**
- Test: `packages/shared/test/unit/funding.test.ts`

**Step 1: Tests**
- `ensureAgentFunded` reads PDA balance from mock RPC and throws when below threshold
- Threshold matches `AGENT_FEE_SOL` env or default
- Returns silently when funded

**Step 2: Commit**

---

### Task 1.7: `umi.ts` — keypair decode + RPC wiring

**Files:**
- Test: `packages/shared/test/unit/umi.test.ts`

**Step 1: Tests**
- Decodes valid 64-byte JSON array keypair
- Rejects keypairs of wrong length with clear error
- Rejects malformed JSON
- `createUmi` wires the configured RPC URL into umi.rpc

**Step 2: Commit**

---

### Task 1.8: `context.ts` — RequestContext typed accessors

**Files:**
- Test: `packages/shared/test/unit/context.test.ts`

**Step 1: Tests**
- Typed getters return values set via constructor
- Missing keys return undefined (not throw)
- `setTransactionSender` stores callable

**Step 2: Commit**

---

### Task 1.9: Round out `siws.ts` and `nonce-store.ts`

**Files:**
- Modify: `packages/shared/test/unit/siws.test.ts`
- Modify: `packages/shared/test/unit/nonce-store.test.ts`

**Step 1: Add SIWS edge cases**
- Empty `agentName` → still produces a parseable canonical form
- Unicode in agentName preserved byte-for-byte
- Nonce containing a newline rejected at build time (this would break the canonical form)

**Step 2: Add nonce-store edge cases**
- TTL expiry actually evicts (advance injected clock past TTL)
- `consume(unknownNonce)` returns false, does not throw
- `consume(validNonce)` returns true and then false on second call (single-use)
- Concurrent `issue` calls produce distinct nonces (run 100 in parallel, assert set size = 100)

**Step 3: Commit**

---

### Task 1.10: `wallet-rate-limit.ts` — extend with sliding window edges

**Files:**
- Modify: `packages/shared/test/unit/wallet-rate-limit.test.ts`

**Step 1: Additional tests**
- Exactly `limit` requests within window pass
- `limit + 1` request within window rejects
- Request at `window_ms + 1` after first allows again (sliding window)
- LRU eviction: after exceeding tracked-wallets cap, oldest wallet's count resets
- Owner exemption bypasses limiter

**Step 2: Commit**

---

### Task 1.11: `paas.ts` — partner-as-a-service API

**Files:**
- Modify: `packages/shared/test/unit/paas.test.ts`

**Step 1: Use `nock` to mock the PaaS endpoint.** Tests:
- Successful agent-context fetch returns parsed payload
- 4xx returns null (graceful degrade) — but logs warning
- 5xx throws (transient, should not be silently swallowed)
- Timeout (>5s) aborts

**Step 2: Commit**

---

### Task 1.12: `server-limits.ts`

**Files:**
- Test: `packages/shared/test/unit/server-limits.test.ts`

**Step 1: Tests** — list every limit constant, assert env override precedence and default values.

**Step 2: Commit**

---

### Task 1.13: Raise coverage threshold to 50%

**Files:**
- Modify: `scripts/check-coverage.ts:3` — `MIN_LINES_PCT = 50`

Run: `pnpm test:coverage && tsx scripts/check-coverage.ts`
Expected: PASS at >= 50%.

```bash
git add scripts/check-coverage.ts
git commit -m "ci: raise coverage threshold to 50% after Phase 1"
```

---

## Phase 2 — Tool Integration Tests

Each tool gets a focused integration test that drives `execute()` with a fake RequestContext and asserts:
1. What it reads from RPC / Jupiter (via mocks)
2. What transaction it builds (assert ix kind + key params, not full byte equality)
3. What it returns to the agent
4. Error paths (RPC failure, insufficient funds, missing context)

Convention: one test file per tool, at `packages/core/test/integration/tools/<tool-name>.test.ts`.

### Task 2.1: `get-balance` tool

**Files:**
- Test: `packages/core/test/integration/tools/get-balance.test.ts`

**Step 1: Test**

```typescript
import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { startMockRpc, type MockRpc } from '@metaplex-foundation/shared/test/helpers/mock-rpc.js';
import { fakeContext } from '../../helpers/mock-context.js';
import { isolateEnv, restoreEnv, defaultTestEnv } from '@metaplex-foundation/shared/test/helpers/env.js';
import { getBalanceTool } from '../../../src/tools/shared/get-balance.js';

let rpc: MockRpc;

beforeEach(async () => {
  rpc = await startMockRpc();
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url }));
});

afterEach(async () => {
  restoreEnv();
  await rpc.close();
});

test('get-balance returns lamports for the configured wallet', async () => {
  rpc.on('getBalance', () => ({ context: { slot: 1 }, value: 5_000_000_000 }));
  const result = await getBalanceTool.execute(
    { wallet: 'OwnerWalletAddressPlaceholder1111111111111' },
    { requestContext: fakeContext() } as any,
  );
  assert.equal(result.lamports, 5_000_000_000);
  assert.equal(result.sol, 5);
  assert.equal(rpc.calls[0].method, 'getBalance');
});

test('get-balance surfaces RPC errors with sanitized messages', async () => {
  rpc.on('getBalance', () => { throw new Error('node down'); });
  await assert.rejects(
    () => getBalanceTool.execute({ wallet: 'invalid' }, { requestContext: fakeContext() } as any),
    /balance/i,
  );
});
```

**Step 2: Run and commit**

---

### Task 2.2: `get-token-balances` tool

Similar shape: mock `getTokenAccountsByOwner`, assert parsed balances + filter by mint.

---

### Task 2.3: `get-token-metadata` tool

Mock `getAccountInfo` for metadata PDA, assert decoded name/symbol/uri.

---

### Task 2.4: `get-token-price` tool

Mock Jupiter `/v1/price` (or whichever endpoint), assert returned price + caching behavior.

---

### Task 2.5: `get-transaction` tool

Mock `getTransaction`, assert decoded instruction summary.

---

### Task 2.6: `sleep` tool

No mocks needed. Tests:
- Resolves after specified ms (use a short ms like 10)
- Aborts when `abortSignal` fires before timer elapses
- Rejects invalid (negative, NaN) durations

---

### Task 2.7: `swap-token` tool

Mock Jupiter `/v1/quote` + `/v1/swap`. Tests:
- Public mode: returns base64 tx for user signature, does not broadcast
- Autonomous mode: signs and submits via mock RPC `sendTransaction`
- Slippage param flows through to Jupiter quote
- Insufficient input balance → typed error
- Jupiter 4xx → typed error

---

### Task 2.8: `launch-token` tool

Mock Genesis SDK calls (or stub at the umi level). Tests:
- Builds asset-creation tx with correct metadata URI
- Rejects when metadata URI fails Irys-domain validation
- Token mint persisted into agent-state.json (autonomous)

---

### Task 2.9: `register-agent` tool

Tests:
- Builds Agent Registry mintAndSubmit tx
- Public mode adds AGENT_FEE_SOL transfer prepended
- Returns agentAssetAddress, persisted to state file
- Re-registration with existing assetAddress is a no-op (returns existing)

---

### Task 2.10: `delegate-execution` tool

Test PDA derivation + delegate ix construction.

---

### Task 2.11: `fund-agent-sol` tool

Public mode: tx with user→PDA transfer. Autonomous mode: rejects (or no-op).

---

### Task 2.12: `buyback-token` tool

Mock Jupiter swap. Assert:
- Quote uses `agentTokenMint` as output
- Slippage applied
- Fee skim logic (if any) correctly subtracts

---

### Task 2.13: `sell-token` tool

Inverse of buyback — output is wSOL, input is agentTokenMint. Same shape.

---

### Task 2.14: `transfer-sol` tool (public only)

Tests:
- Builds transfer ix from user → recipient
- AGENT_FEE_SOL prepended
- Returns base64 tx (not broadcast)

---

### Task 2.15: `transfer-token` tool (public only)

Tests:
- Creates recipient ATA if missing
- Transfers correct amount with decimals
- AGENT_FEE_SOL fee prepended

---

### Task 2.16: `set-paused` tool (autonomous only)

Tests:
- Writes paused flag to state file
- Returns confirmation
- Idempotent (pausing already-paused state OK)

---

### Task 2.17: `withdraw-sol` tool (autonomous only)

Tests:
- Builds + signs + submits transfer PDA → owner
- Respects TxCounter cap
- Dry-run mode returns `DRYRUN_*` signature

---

### Task 2.18: `goals-tasks` toolset (autonomous only)

One test file covering all four sub-tools (`set-goal`, `add-task`, `close-task`, `close-goal`):
- `set-goal` paraphrases-then-confirms requires `confirmed: true` flag to commit
- `add-task` rejects if no active goal
- `close-task` updates state
- `close-goal` closes all child tasks too (or rejects if tasks open — match actual behavior)

---

### Task 2.19: Tool registry sanity test

**Files:**
- Test: `packages/core/test/integration/tool-registry.test.ts`

**Step 1: Test**

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { publicAgentTools } from '../../src/tools/index.js';  // adjust to actual export
import { autonomousAgentTools } from '../../src/tools/index.js';

test('public toolset has stable shape', () => {
  const names = Object.keys(publicAgentTools).sort();
  assert.deepEqual(names, [
    'buyback-token', 'delegate-execution', 'fund-agent-sol', 'get-balance',
    'get-token-balances', 'get-token-metadata', 'get-token-price',
    'get-transaction', 'launch-token', 'register-agent', 'sell-token',
    'sleep', 'swap-token', 'transfer-sol', 'transfer-token',
  ]);
});

test('autonomous toolset has stable shape', () => {
  const names = Object.keys(autonomousAgentTools).sort();
  assert.deepEqual(names, [
    'add-task', 'buyback-token', 'close-goal', 'close-task',
    'delegate-execution', 'fund-agent-sol', 'get-balance',
    'get-token-balances', 'get-token-metadata', 'get-token-price',
    'get-transaction', 'launch-token', 'register-agent', 'sell-token',
    'set-goal', 'set-paused', 'sleep', 'swap-token', 'withdraw-sol',
  ]);
});

test('public toolset does not leak autonomous-only tools', () => {
  for (const banned of ['set-paused', 'withdraw-sol', 'set-goal']) {
    assert.equal(banned in publicAgentTools, false, `${banned} leaked`);
  }
});
```

This is a regression net: if anyone adds a tool to the wrong toolset, this fails.

**Step 2: Commit.**

---

### Task 2.20: Raise coverage threshold to 70%

`MIN_LINES_PCT = 70`, commit.

---

## Phase 3 — Agent Assembly Integration Tests

### Task 3.1: `prompts.ts` — system prompt assembly

**Files:**
- Test: `packages/core/test/integration/prompts.test.ts`

**Step 1: Tests**
- `buildSystemPrompt('public')` includes PUBLIC_ADDENDUM, excludes AUTONOMOUS_ADDENDUM
- `buildSystemPrompt('autonomous')` includes AUTONOMOUS_ADDENDUM (goals/tasks/journal language)
- `buildSystemPrompt('autonomous', { persona: 'treasury-rebalancer' })` injects persona body
- Unknown persona falls back to `default` (warning logged)
- All built prompts begin with BASE_HEADER (assert prefix match)

**Step 2: Commit**

---

### Task 3.2: `create-agent.ts` — mode dispatch

**Files:**
- Test: `packages/core/test/integration/create-agent.test.ts`

**Step 1: Tests**
- `AGENT_MODE=public` → returned agent has `transfer-sol`, `transfer-token`, no autonomous tools
- `AGENT_MODE=autonomous` → returned agent has `set-paused`, `withdraw-sol`, `set-goal`, no transfer tools
- Invalid AGENT_MODE → throws clear error
- Agent's `id` and `name` match `ASSISTANT_NAME` env

Don't call `agent.generate()` — that needs the live Anthropic API. Just inspect agent shape.

**Step 2: Commit**

---

### Task 3.3: Persona loading

**Files:**
- Modify: `packages/core/test/unit/personas.test.ts`

**Step 1: Extend existing test with**
- Each persona file (`token-launch-concierge`, `treasury-rebalancer`, `wallet-cleanup-bot`, `default`) loads without error
- Each persona has required fields (`name`, `body`)
- `body` is non-empty string

**Step 2: Commit**

---

## Phase 4 — Worker Loop Integration Tests

### Task 4.1: Worker loop tick — happy path

**Files:**
- Test: `packages/server/test/integration/worker-loop.test.ts`
- Helper: `packages/server/test/helpers/fake-clock.ts`

**Step 1: Build `fake-clock.ts`**

```typescript
// packages/server/test/helpers/fake-clock.ts
export interface FakeClock {
  now(): number;
  advance(ms: number): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export function makeFakeClock(start = 0): FakeClock {
  let current = start;
  const pending: { fireAt: number; resolve: () => void }[] = [];

  return {
    now() { return current; },
    sleep(ms: number) {
      return new Promise<void>((resolve) => {
        pending.push({ fireAt: current + ms, resolve });
      });
    },
    async advance(ms: number) {
      current += ms;
      const due = pending.filter(p => p.fireAt <= current);
      for (const p of due) {
        pending.splice(pending.indexOf(p), 1);
        p.resolve();
      }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}
```

**Step 2: Refactor `worker-loop.ts` to accept an injected clock + agent**

Worker loop currently calls `setTimeout` directly. Add a `WorkerLoopOpts` arg:
```typescript
interface WorkerLoopOpts {
  agent: { generate: (...args: any[]) => Promise<any> };
  clock?: { now(): number; sleep(ms: number): Promise<void> };
  state?: StateAccessor;
}
```
Default to real Date/setTimeout. Tests inject fakes.

**Step 3: Test — tick with no goals is idle**

```typescript
test('worker tick is a no-op when there are no active goals', async () => {
  // ... setup state file with no goals, fake clock, stub agent
  const agent = makeStubAgent({});
  await runTick({ agent, clock: fakeClock, statePath: tmpState });
  assert.equal(agent.toolResults.size, 0, 'agent should not have been invoked');
});
```

**Step 4: Test — tick with active goal calls agent.generate**

Set state to have one active goal. Assert `agent.generate` called once. Assert journal entry appended.

**Step 5: Test — tick respects TxCounter cap**

Stub agent calls `swap-token` 5 times. With `MAX_TICK_TX_COUNT=3`, only 3 should succeed; 4th throws.

**Step 6: Test — dry-run mode produces synthetic signatures**

With `AUTONOMOUS_DRY_RUN=true`, swap tool returns `DRYRUN_*` signature. Assert no `sendTransaction` call on mock RPC.

**Step 7: Test — error streak auto-pauses at 3**

Make `agent.generate` throw 3 times consecutively. After 3rd tick, state file has `paused: true`.

**Step 8: Test — successful tick resets error streak**

After 2 failures + 1 success, error streak is 0.

**Step 9: Test — paused worker short-circuits**

Set `paused: true` in state. Run tick. Assert `agent.generate` not called.

**Step 10: Commit**

```bash
git add packages/server/test/integration/worker-loop.test.ts packages/server/test/helpers/fake-clock.ts packages/server/src/worker-loop.ts
git commit -m "test(server): cover worker loop ticks, error streak, dry-run, TxCounter"
```

---

### Task 4.2: `build-tick-prompt.ts` — deterministic prompt assembly

**Files:**
- Test: `packages/server/test/unit/build-tick-prompt.test.ts`

**Step 1: Tests**
- Given a fixed `TickContext`, the produced prompt is byte-identical (snapshot)
- Prompt includes wallet balance, PDA balance, all active goals, all open tasks
- Truncates journal to last 5 entries, closed tasks to last 5
- Dry-run flag surfaces in prompt
- TxCounter remaining surfaces in prompt

**Step 2: Commit**

---

## Phase 5 — WebSocket E2E Tests

The big one. Spin up the real server, connect a real `ws` client, drive a full authenticated conversation with a stub model and mocked RPC.

### Task 5.1: E2E harness

**Files:**
- Create: `packages/server/test/helpers/e2e-server.ts`

**Step 1: Build a `startTestServer()` function** that:
- Starts the server on `port: 0` (ephemeral)
- Returns `{ url: 'ws://127.0.0.1:<port>', port, agent: StubAgent, rpc: MockRpc, close: () => Promise<void> }`
- Wires the stub agent into `createAgent()` (may need a small refactor in `create-agent.ts` to accept an injected agent for testing)
- Wires the mock RPC URL into config
- Generates a fresh keypair per server, exposes the public key
- Sets `AUTH_AUTHZ_MODE=open` by default so tests don't need to pre-stage allowlists

**Step 2: Build a `connectAuthenticated(url, wallet)` helper** that:
- Opens a `ws` connection
- Waits for `connected`
- Sends `auth_request`
- Receives `auth_challenge`, signs the canonical message with `wallet`'s tweetnacl keypair
- Sends `auth_response`
- Waits for `authenticated`
- Returns `{ socket, sessionId }`

**Step 3: Smoke test the harness** at `packages/server/test/e2e/harness-smoke.test.ts`:

```typescript
test('test server boots and accepts SIWS auth', async () => {
  const env = await startTestServer();
  const wallet = nacl.sign.keyPair();
  const { sessionId } = await connectAuthenticated(env.url, wallet);
  assert.ok(sessionId);
  await env.close();
});
```

**Step 4: Commit**

---

### Task 5.2: E2E — SIWS auth failure modes

**Files:**
- Test: `packages/server/test/e2e/auth-failures.test.ts`

**Step 1: Each test connects a fresh client and drives one failure**
- Wrong nonce → `auth_error { code: 'nonce_invalid' }` + close 4001
- Stale nonce (advance time past 60s before responding) → `nonce_expired`
- Tampered canonical message → `message_mismatch`
- Invalid signature bytes → `signature_invalid`
- Not authorized (in `owner` or `allowlist` mode with stranger wallet) → `not_authorized`
- Handshake timeout (don't respond within `AUTH_HANDSHAKE_TIMEOUT_MS`) → connection closed

**Step 2: Commit**

---

### Task 5.3: E2E — Chat message flow

**Files:**
- Test: `packages/server/test/e2e/chat.test.ts`

**Step 1: Tests**
- Authenticated client sends `message` → server echoes via `typing: true`, agent generates a text-only response, server emits `message` (sender: agent), then `typing: false`
- Stub agent scripted with `[{type:'text', content:'hello back'}]`
- Assert message ordering, content, sender field
- Per-wallet rate limit: send 61 messages in <60s, 61st rejected with `error { code: 'RATE_LIMIT' }`
- Per-session rate limit: send 21 messages in <10s, 21st rejected
- Owner wallet exempt from rate limits

**Step 2: Commit**

---

### Task 5.4: E2E — Transaction signing round-trip

**Files:**
- Test: `packages/server/test/e2e/transaction-flow.test.ts`

**Step 1: Tests**
- Stub agent scripted to call `transfer-sol` tool
- Server emits `transaction { txn, correlationId, feeSol, message }`
- Client responds with `tx_result { correlationId, signature: 'FakeSig111...' }`
- Server consumes the result, agent's next response references the signature
- `tx_error` path: client rejects, agent gets the sanitized reason
- Multiple transactions in one tool call: `index`/`total` fields correct, processed in order

**Step 2: Commit**

---

### Task 5.5: E2E — Allowlist administration

**Files:**
- Test: `packages/server/test/e2e/allowlist.test.ts`

**Step 1: Tests**
- Owner sends `allowlist_add`, server responds `allowlist_state` with new wallet
- Non-owner sends `allowlist_add` → `allowlist_error { code: 'not_authorized' }`
- `allowlist_remove` removes
- `allowlist_list` returns the current set
- Changes persist to allowlist file
- Invalid base58 wallet → `allowlist_error`

**Step 2: Commit**

---

### Task 5.6: E2E — Protocol error handling

**Files:**
- Test: `packages/server/test/e2e/protocol-errors.test.ts`

**Step 1: Tests (post-auth)**
- Send invalid JSON → `error { code: 'INVALID_JSON' }`, connection stays open
- Send message > size limit → `error { code: 'MESSAGE_TOO_LARGE' }`
- Send unknown `type` → `error { code: 'UNKNOWN_TYPE' }`

**Step 2: Commit**

---

### Task 5.7: E2E — Debug events

**Files:**
- Test: `packages/server/test/e2e/debug-events.test.ts`

**Step 1: Tests**
- With `ENABLE_DEBUG_EVENTS=true`, server emits `debug:step_start`, `debug:tool_call`, `debug:tool_result`, `debug:generation_complete` during a scripted tool call
- With flag off, none of these are emitted
- Assert event ordering and payload shape

**Step 2: Commit**

---

### Task 5.8: E2E — Connection lifecycle

**Files:**
- Test: `packages/server/test/e2e/connection-lifecycle.test.ts`

**Step 1: Tests**
- Client disconnects mid-tx-signing → server cleans up pending correlation, no leak
- Multiple concurrent clients each get distinct session IDs
- Connection limit (if any) rejects 11th client with appropriate close code
- Server graceful shutdown: in-flight messages complete, new connections rejected

**Step 2: Commit**

---

### Task 5.9: Raise coverage threshold to 80%

`MIN_LINES_PCT = 80`. Commit.

---

## Phase 6 — Documentation + Final Polish

### Task 6.1: Document test layout in README

**Files:**
- Modify: `README.md`

**Step 1: Add a "Testing" section** explaining:
- `pnpm test` runs everything
- `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e` for layer-specific runs
- `pnpm test:coverage` produces lcov.info
- Test directory layout convention
- How to write a new tool test (link to one existing example)
- How to run a single test file (`node --test --import tsx path/to/test.ts`)

**Step 2: Commit**

---

### Task 6.2: Add test conventions doc

**Files:**
- Create: `docs/testing.md`

**Step 1: Document**
- The three layers and what belongs in each
- The mocking boundaries (RPC, Jupiter, Anthropic, FS, time)
- Helper inventory with one-line descriptions
- "Add a new tool test" recipe (10 lines)
- "Add a new E2E scenario" recipe
- Coverage thresholds and how to raise them
- Anti-patterns: don't hit real RPC; don't use real Anthropic key in tests; don't `setTimeout` in tests (use injected clock)

**Step 2: Commit**

---

### Task 6.3: Add a flaky-test policy stub

**Files:**
- Modify: `docs/testing.md`

**Step 1: One paragraph** — "Tests that fail intermittently get marked `.skip` with a TODO ticket, never retried. We don't have a retry mechanism and won't add one — flakiness is a bug, not a feature of the test runner."

**Step 2: Commit**

---

### Task 6.4: Sanity-check coverage report locally

**Step 1:** `pnpm test:coverage`

**Step 2:** Open each `packages/*/coverage/lcov.info` and verify >= 80% line coverage per package.

**Step 3:** Identify any module < 50% — file a follow-up task list (not part of this plan).

---

## Phase 7 — Stretch (not required for "comprehensive")

These are nice-to-haves; tackle only if Phase 0-6 lands and we want more depth.

- **Property-based tests** for canonical-form invariants (SIWS message, base58 round-trips). Use `fast-check`.
- **Snapshot tests** for `build-tick-prompt` output (catch unintended prompt drift). Use a homegrown snapshot helper — don't bring Jest in for one feature.
- **Contract tests** between the chat-template frontend and the server WebSocket protocol — one shared JSON fixture file consumed by both repos.
- **Mutation testing** with Stryker on `packages/shared/src/` to verify our unit tests actually catch real bugs.
- **Localnet integration job** in a nightly (not per-PR) workflow: spin up `solana-test-validator`, run the autonomous loop against it for 10 ticks, assert journal grows + no errors.

---

## Acceptance criteria

This plan is "done" when:

1. `pnpm test` runs all three layers and passes on a clean checkout
2. CI runs tests on every PR and blocks merge on failure
3. Coverage is ≥80% line coverage across `packages/*/src/`, enforced in CI
4. Every tool has at least one integration test exercising its happy path and one error path
5. Every WebSocket message type has at least one E2E test
6. The worker loop has tests for: happy path, idle path, error streak, dry-run, TxCounter cap, pause/resume
7. `docs/testing.md` exists and explains the conventions
8. No test depends on real Solana RPC, real Anthropic API, or real network

---

## Notes on sequencing

- Phases 0 → 1 → 2 → 3 → 4 → 5 → 6 are sequential. Phase 7 is post-merge.
- Within a phase, tasks are mostly independent and can be parallelized with subagents.
- Each task is one commit. Roll back individual tasks if they break something.
- Coverage threshold rises step-by-step (10% → 50% → 70% → 80%) so we don't block our own PRs while building out the suite.

## Risks

- **Mastra/Umi API drift**: if `@mastra/core` or `@metaplex-foundation/umi` ship breaking changes, the stub interfaces need updates. Mitigation: pin versions in `package.json` and update deliberately.
- **Refactor needs in `worker-loop.ts`, `create-agent.ts`, `auth.ts`** to accept injected dependencies (clock, agent, on-chain lookup). These refactors are scoped within the tasks that need them; they're small (add an optional opts param, default to existing behavior).
- **Coverage gaming**: 80% line coverage doesn't mean the tests are good. The acceptance criteria explicitly call out per-tool happy + error paths and per-message-type E2E coverage so we hit real behavior, not just lines.
