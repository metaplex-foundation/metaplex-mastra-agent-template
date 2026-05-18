# Testing Conventions

This document covers the layered test suite, mocking boundaries, helper inventory, and the recipes for adding new tests. The runner is `node --test` — no Jest, Vitest, or Mocha. Read [`README.md`](../README.md#testing) first for the command surface.

Current state: 404 tests across `shared` (170) + `core` (152) + `server` (82), 88.98% line coverage, CI threshold 85%.

## Layer split

The three layers map to three directories per package. A test belongs in a layer based on what it touches, not what it covers.

- **Unit** (`packages/*/test/unit/`) — pure functions, deterministic, zero I/O. State helpers, config parsing, SIWS canonical form, rate-limit math. Should run in well under a second per file.
- **Integration** (`packages/*/test/integration/`) — exercises a tool's `execute()` or an agent assembly path against mocked RPC/HTTP boundaries. No real network, no real Anthropic, no real Solana. Lives in `core` (tools, agent assembly) and `server` (worker loop tick).
- **E2E** (`packages/server/test/e2e/`) — boots the real WebSocket server on an ephemeral port, connects a real `ws` client, drives a full authenticated conversation against a stub streaming agent and a mocked Solana RPC. Server package only.

## Mocking boundaries

Every place the runtime crosses a network, disk, or time boundary has a documented mock. Tests must use these — never reach for the real thing.

| Boundary | Mock | Helper |
|---|---|---|
| Solana JSON-RPC | In-process HTTP server | `startMockRpc()` from `@metaplex-foundation/shared/test/helpers/mock-rpc.js` |
| Jupiter / external HTTPS | `nock` interceptors | `nock` (dev dep on `shared` and `server`) |
| Anthropic / Mastra model | Scripted stub | `makeStubAgent` from `packages/core/test/helpers/mock-agent.ts` (non-streaming) |
| Anthropic streaming (E2E) | Streaming stub matching Mastra chunk shape | `makeStreamingStubAgent` from `packages/server/test/helpers/stub-streaming-agent.ts` |
| File system (`agent-state.json`, allowlists, `.env`) | `os.tmpdir()` + `process.chdir()` | pattern in `packages/shared/test/unit/state.test.ts` |
| Time (`Date.now`, sleeps) | Injected clock | `now?: () => number` constructor option on `NonceStore`, `WalletRateLimiter`; fake clock helper for worker loop |
| Config singletons | Module-level reset | `_resetConfigForTests()` from `@metaplex-foundation/shared` |
| Server-limits singleton | Module-level reset | `_resetLimitsForTests()` from `@metaplex-foundation/shared` |

If you find yourself wanting to call `process.exit`, `setTimeout`, or `fetch` directly in a test, stop — there is already a helper. If there genuinely isn't, add one to the relevant `test/helpers/` directory.

## Helper inventory

All helpers live next to the tests they support — no shared test package.

- `packages/shared/test/helpers/env.ts` — env isolation: `isolateEnv(overrides)`, `restoreEnv()`, `defaultTestEnv(extra)`, `ZERO_KEYPAIR` constant.
- `packages/shared/test/helpers/mock-rpc.ts` — `startMockRpc()` returns an in-process Solana JSON-RPC server with `.on(method, handler)`, `.calls[]`, `.close()`. Also exports `blockhashFixture()`.
- `packages/shared/test/helpers/umi.ts` — `makeTestUmi(rpcUrl)` for a UMI instance pointed at the mock RPC; `stubUmiRpc(umi)` swaps RPC methods for spy/stub versions.
- `packages/core/test/helpers/mock-agent.ts` — `makeStubAgent(tools)` returns a non-streaming stub Mastra agent with `setScript([{ type: 'tool-call' | 'text', ... }])` and a `toolResults` map.
- `packages/core/test/helpers/mock-context.ts` — `fakeContext(opts)` builds a `RequestContext` populated with sensible defaults (walletAddress, agentMode, agentAssetAddress, abortSignal, optional txCounter).
- `packages/server/test/helpers/e2e-server.ts` — `startTestServer()` boots the server on `port: 0` with injected stub agent + mock RPC; `connectAuthenticated(env)` opens a `ws` connection and completes the SIWS handshake.
- `packages/server/test/helpers/stub-streaming-agent.ts` — `makeStreamingStubAgent(tools)` produces chunks shaped like `@mastra/core` streaming output (text deltas, tool calls, tool results, finish).

## Add a new tool test

Drop this skeleton into `packages/core/test/integration/tools/<your-tool>.test.ts`:

```typescript
import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { startMockRpc, type MockRpc } from '@metaplex-foundation/shared/test/helpers/mock-rpc.js';
import { isolateEnv, restoreEnv, defaultTestEnv } from '@metaplex-foundation/shared/test/helpers/env.js';
import { _resetConfigForTests } from '@metaplex-foundation/shared';
import { fakeContext } from '../../helpers/mock-context.js';
import { myTool } from '../../../src/tools/shared/my-tool.js';

let rpc: MockRpc;

beforeEach(async () => {
  rpc = await startMockRpc();
  rpc.on('getBalance', () => ({ context: { slot: 1 }, value: 5_000_000_000 }));
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url }));
  _resetConfigForTests();
});

afterEach(async () => {
  await rpc.close();
  restoreEnv();
  _resetConfigForTests();
});

test('myTool happy path', async () => {
  const result = await myTool.execute(
    { /* args */ },
    { requestContext: fakeContext() } as any,
  );
  assert.equal(result.status, 'success');
});
```

The `as any` on `requestContext` is intentional — Mastra's `RequestContext` type has private fields that don't unify across package resolution paths, so the cast is the documented workaround (see MEMORY.md).

## Add a new E2E scenario

Drop this skeleton into `packages/server/test/e2e/<scenario>.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { startTestServer, connectAuthenticated } from '../helpers/e2e-server.js';

test('scenario', async () => {
  const env = await startTestServer();
  env.agent.setScript([{ type: 'text', content: 'hi' }]);
  const client = await connectAuthenticated(env);
  client.send({ type: 'message', content: 'hello' });
  const reply = await client.waitFor('message');
  assert.match(reply.content, /hi/);
  await client.close();
  await env.close();
});
```

`startTestServer()` already sets `AUTH_AUTHZ_MODE=open` so the wallet generated inside `connectAuthenticated` passes authorization. Override per-test via env if you want to exercise allowlist/owner paths. `client.waitFor(type)` returns the next inbound message of that type; `client.send(obj)` JSON-encodes and sends.

## Coverage thresholds

The CI gate is enforced by `scripts/check-coverage.ts`, which reads each package's `lcov.info` and totals `LF` / `LH`. Current floor: 85% (`MIN_LINES_PCT` in the script).

To raise the floor:

1. Bump `MIN_LINES_PCT` in `scripts/check-coverage.ts`.
2. Run `pnpm test:coverage && tsx scripts/check-coverage.ts` locally — it must pass.
3. Open a PR. CI will block any future drop below the new floor.

Coverage is a regression net, not a quality bar. A 100% covered file with no assertions catches nothing.

## Anti-patterns

DO NOT:

- Hit real Solana RPC in tests. Use `startMockRpc()`. If a test needs an unmocked method, add a handler — don't skip the mock.
- Use a real Anthropic API key. Use `makeStubAgent` (integration) or `makeStreamingStubAgent` (E2E). `agent.generate()` against the live API is forbidden in CI.
- Use raw `setTimeout` for delays. Inject a clock where available (`NonceStore`, `WalletRateLimiter`, the worker loop). Short real sleeps are tolerated only as a last resort and only in E2E.
- Test against `agent.generate()` without stubbing. The Mastra agent must always be a stub in tests — even "smoke" tests that look harmless will become slow, flaky, and expensive once they accumulate.
- Mutate `process.env` without `isolateEnv` / `restoreEnv`. Singletons (config, server-limits) cache the first read; stale env leaks across tests.
- Add a retry mechanism for flaky tests. See below.

## Flaky test policy

Tests that fail intermittently get marked `.skip` with a TODO ticket, never retried. We don't have a retry mechanism and won't add one — flakiness is a bug in the test, not a feature of the runner. Investigate, fix the root cause (timing assumption, shared state, real network call), and unskip. If you can't fix it within a day, delete the test rather than ship a polluted signal.

## Per-file coverage notes

All source files are above 50% per-file line coverage as of 2026-05-16. The lowest covered file is `packages/shared/src/jupiter.ts` at 64.15% — the uncovered lines are deep error paths in the swap-build flow that require Jupiter API failure-mode fixtures beyond what the current `nock` setup exercises.

The `check-coverage` script's "Uncovered files" list (8 files at the time of writing) calls out files the test runner did not instrument at all — these are deliberately not unit-tested:

- `packages/server/src/index.ts` (server bootstrap, exercised end-to-end by `test/e2e/`)
- `packages/core/src/index.ts`, `packages/shared/src/index.ts` (barrel re-exports)
- `packages/shared/src/error-codes.ts` (const taxonomy, no logic)
- `packages/shared/src/types/*.ts`, `packages/core/src/personas/types.ts` (type-only files)

These are acceptable gaps and intentionally excluded — they would inflate coverage without testing behavior. Revisit only if one of these files grows real logic.
