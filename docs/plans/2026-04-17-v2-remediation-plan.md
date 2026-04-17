# Review v2 Remediation — Implementation Plan

**Date:** 2026-04-17
**Design doc:** `docs/plans/2026-04-17-v2-remediation-design.md`
**Report:** `docs/REVIEW_REPORT_V2.md`

## Execution structure

Four parallel workstreams (A, B, C, D) after a small shared foundation. Each agent owns a disjoint set of files to avoid merge conflicts.

### File ownership

| Workstream | Owns                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** (Server)   | `packages/server/**`, `packages/shared/src/config.ts`, `packages/shared/src/server-limits.ts`                                                                              |
| **B** (Tools)    | `packages/core/src/**`, `packages/shared/src/auth.ts`, `packages/shared/src/jupiter.ts`, `packages/shared/src/transaction.ts`, `packages/shared/src/index.ts`, **NEW** `packages/shared/src/types/tool-result.ts`, **NEW** `packages/shared/src/context.ts` |
| **C** (Frontend) | `packages/ui/**`                                                                                                                                                          |
| **D** (Docs)     | `docs/SPEC.md`, `WEBSOCKET_PROTOCOL.md`, `README.md`, `.env.example`, `packages/ui/.env.local.example`                                                                     |

### Shared contract (read-only by all, writable by none except the owner)

Workstreams A and B both need to know the final names of new env vars / types. These are fixed before dispatch:

- **New env vars (A adds to config.ts):** `WS_ALLOWED_ORIGINS` (string, comma-separated, default `"http://localhost:3001,http://localhost:3000"`), `MAX_MESSAGE_CONTENT` (number, default `8000`), `MAX_RPC_TIME_BUDGET_MS` (number, default `60000`), `LOG_AUTH_FAILURES` (boolean, default `true`).
- **New UI env var (C adds to UI env):** `NEXT_PUBLIC_SOLANA_CLUSTER` (`mainnet-beta | devnet | testnet`, default `devnet`).
- **New shared types (B adds):** `ToolResult<T>`, `ToolErrorCode`, `ok()`, `err()` helpers from `packages/shared/src/types/tool-result.ts`. `readAgentContext()` from `packages/shared/src/context.ts`.

---

## Workstream A — Server hardening

### Steps

1. Add env vars to `packages/shared/src/config.ts`: `WS_ALLOWED_ORIGINS`, `MAX_MESSAGE_CONTENT`, `MAX_RPC_TIME_BUDGET_MS`, `LOG_AUTH_FAILURES`. Raise `WEB_CHANNEL_TOKEN` min to 32 (M7). Chain `.refine()` on all base58 address fields (`AGENT_ASSET_ADDRESS`, `AGENT_TOKEN_MINT`, `TOKEN_OVERRIDE`, `OWNER_WALLET`) that decodes with `bs58` and checks length is 32 (M6).
2. `packages/server/src/websocket.ts`:
   - (C1) Add `sanitizeForPrefix(s)` helper — strip `[`, `]`, `\r`, `\n`, cap at 88 chars. Use in chat prefix for wallet address AND agent-status label.
   - (C2) Add `verifyClient` option to `WebSocketServer` that rejects origins not in `WS_ALLOWED_ORIGINS`; allow undefined (curl) with warning.
   - (C3) Accept token from `Sec-WebSocket-Protocol` header (first subprotocol named `bearer`); echo back the `bearer` subprotocol on accept. Keep existing query + Authorization header paths.
   - (C5) In autonomous-mode gate at the start of handling a `message`, call `resolveOwner()` and compare to `session.walletAddress`; if mismatch, clear `isOwnerVerified`, send error, return.
   - (H8) Refactor cleanup into `cleanupSession(ws)` idempotent helper; invoke from both `close` and `error` handlers. In `error`, call `ws.terminate()` to guarantee close fires.
   - (M1) Leave `jid` as `web:${session.id}`. (Workstream D updates the doc to match.)
   - (M3) Enforce `content.length <= config.MAX_MESSAGE_CONTENT`; send error and return.
   - (M5) Track cumulative RPC wall-clock per message via a stopwatch; on exceed `config.MAX_RPC_TIME_BUDGET_MS`, call `abortController.abort()`.
   - (M10) Unknown correlationId on `tx_result` with valid-format signature → log `late-ok`, drop silently (no client error).
   - (L6) `logAuthFailure(reason, meta)` helper gated by `LOG_AUTH_FAILURES`; use at every token mismatch, origin rejection, autonomous gate denial, rate-limit breach.
3. `packages/shared/src/server-limits.ts`: expose `MAX_MESSAGE_CONTENT` and `MAX_RPC_TIME_BUDGET_MS` helpers if it's the designated home for such constants.

### Verify

- `pnpm --filter @metaplex-agent/server typecheck` passes.
- `pnpm --filter @metaplex-agent/shared typecheck` passes.

---

## Workstream B — Tools correctness

### Steps

1. Create `packages/shared/src/types/tool-result.ts`:
   ```ts
   export type ToolErrorCode =
     | 'INSUFFICIENT_FUNDS' | 'INVALID_INPUT' | 'RPC_FAILURE'
     | 'UNAUTHORIZED' | 'NOT_FOUND' | 'TIMEOUT' | 'INTEGRITY'
     | 'GENERIC';
   export type ToolSuccess<T> = { status: 'success' } & T;
   export type ToolInfo<T> = { status: 'info' } & T;
   export type ToolError = { status: 'error'; code: ToolErrorCode; message: string };
   export type ToolResult<T = {}> = ToolSuccess<T> | ToolInfo<T> | ToolError;
   export const ok = <T>(data: T): ToolSuccess<T> => ({ status: 'success', ...data });
   export const info = <T>(data: T): ToolInfo<T> => ({ status: 'info', ...data });
   export const err = (code: ToolErrorCode, message: string): ToolError => ({ status: 'error', code, message });
   ```
2. Create `packages/shared/src/context.ts` with `readAgentContext(ctx: any): AgentContext` that safely reads with defaults.
3. Export both from `packages/shared/src/index.ts`.
4. (H1) Audit every tool's return paths. Replace bare `{...}` returns with `ok(...)`, `info(...)`, or `err(...)`. Files: all `packages/core/src/tools/shared/*.ts` and `public/*.ts`.
5. (H2) `swap-token.ts:26`, `sell-token.ts:18–20`: change amount schema to `z.string().regex(/^\d+(\.\d+)?$/).refine(s => Number(s) > 0, 'must be positive')`. In `buyback-token.ts`, add `.finite()` to the existing `z.number().positive()`.
6. (H3, H4 owner part) `packages/shared/src/auth.ts`:
   - Skip caching when `assetAddress === null` (env rotation hot-reload).
   - Add single-flight `inflightLookups: Map<string, Promise<CachedOwner>>` around `fetchAsset`.
7. (H4 register part) `packages/core/src/tools/shared/register-agent.ts`: module-scoped `inflightRegistration`. Dedupe concurrent calls.
8. (H5) `packages/core/src/tools/shared/sleep.ts`: respect `AbortSignal` from `RequestContext` (server will also set context.get('abortSignal')). Reject on abort.
9. (C4 / M13) `packages/core/src/tools/shared/launch-token.ts`: add required `confirmIrreversible: z.literal(true)` input. Normalize returns via `ok/err/info`.
10. (C6) `packages/shared/src/jupiter.ts`: add `simulateAndVerifySwap(umi, tx, {inputMint, amount, outputMint, minOut})`. Call before `umi.identity.signTransaction` in `executeSwap`. Parse `simulateTransaction` results' `accounts` (or `preTokenBalances`/`postTokenBalances`) to assert:
    - Input debit from agent's input ATA ≤ `amount * (1 + 0.01)` (1% buffer for fees/rounding).
    - Output credit to agent's output ATA ≥ `minOut * (1 - 0.01)` (slippage buffer).
    - No unexpected token-balance changes for the agent's own accounts. Reject with `err('INTEGRITY', ...)`.
11. (M8) `packages/core/src/tools/public/transfer-sol.ts`, `transfer-token.ts`: replace manual `ctx?.get(...)` composition with `readAgentContext(ctx)`.
12. (New) In `packages/core/src/agent-public.ts` and `agent-autonomous.ts`: pass `abortSignal` into `RequestContext` — actually this needs server coordination. Server sets `abortSignal` entry in the RequestContext before `agent.stream()`. Workstream A handles the server side; Workstream B just makes `sleep` read it (the key name is `'abortSignal'`).

### Verify

- `pnpm --filter @metaplex-agent/shared typecheck` passes.
- `pnpm --filter @metaplex-agent/core typecheck` passes.

---

## Workstream C — Frontend UX/a11y

### Steps

1. (C3 client) `packages/ui/src/hooks/use-plexchat.ts`: pass token as subprotocol `new WebSocket(url, ['bearer', token])`. Remove `?token=` from URL builder.
2. (C3 client) `packages/ui/src/app/env.ts`: remove token from URL builder; export token and cluster helpers.
3. (H6) `packages/ui/src/hooks/use-plexchat.ts:203–217`: onclose, check `event.code === 4001`; if so set `intentionalCloseRef.current = true`, setError('Unauthorized'), don't reconnect.
4. (H7) `packages/ui/src/components/transaction-approval.tsx`:
   - Add `role="dialog" aria-modal="true" aria-labelledby="tx-title" aria-describedby="tx-desc"` on modal root.
   - Give title `<h2 id="tx-title">` and description block `<p id="tx-desc">`.
   - `useEffect` to capture `document.activeElement` on open, focus first approve button (via ref), restore focus on unmount.
   - `onKeyDown` at root: Escape → `handleReject()`; Tab → focus-trap between first and last focusable elements.
   - Backdrop click: `onClick={(e) => e.target === e.currentTarget && handleReject()}`.
5. (M9) `packages/ui/src/app/env.ts`: add `NEXT_PUBLIC_SOLANA_CLUSTER` (default `devnet`). `transaction-approval.tsx:190–194`: use this env var instead of sniffing RPC URL.
6. (M11) `packages/ui/src/app/page.tsx`: `useEffect` with `beforeunload` listener when `txQueue.length > 0`.
7. (M12) `packages/ui/src/app/page.tsx:106`: debug panel class `w-full md:w-[400px]`; on mobile toggle should overlay rather than split.
8. Polish:
   - (L1) header: `flex-wrap gap-2`.
   - (L2) chat messages wrapper: `max-w-3xl mx-auto` (or similar).
   - (L3) debounce suggestion buttons (disable while WS not ready).
   - (L4) wrap localStorage in try/catch in `use-debug-panel.ts`.
   - (L5) remove inline cursor when `isStreaming=false` in `chat-message.tsx`.

### Verify

- `pnpm --filter @metaplex-agent/ui typecheck` passes.
- `pnpm --filter @metaplex-agent/ui build` passes.

---

## Workstream D — Docs & protocol

### Steps

1. `docs/SPEC.md`:
   - §3.1 add note: "`launch-token` is always agent-signed regardless of mode (see §10.4)."
   - §5.1 footnote `launch-token` with "agent-signed; requires `confirmIrreversible:true`."
   - §6.6 clarify launch-token exemption; document subprotocol auth option.
   - §8.1 add `WS_ALLOWED_ORIGINS`, `MAX_MESSAGE_CONTENT`, `MAX_RPC_TIME_BUDGET_MS`, `LOG_AUTH_FAILURES`. Bump `WEB_CHANNEL_TOKEN` note to "min 32 chars."
   - §8.2 add `NEXT_PUBLIC_SOLANA_CLUSTER`.
   - §10.4 update to describe simulation-based Jupiter tx integrity check.
   - §12.2 reference subprotocol auth as recommended over query param.
2. `WEBSOCKET_PROTOCOL.md`:
   - Update `jid` to say "per-session id like `web:<uuid>`" (matches code).
   - Document subprotocol `bearer` as auth option alongside query + Authorization header.
3. `README.md`:
   - Env var table updates.
   - "Production auth" note referencing subprotocol.
4. `.env.example` and `packages/ui/.env.local.example`:
   - Add all new env vars with commented defaults.

### Verify

- `pnpm typecheck` at repo root.

---

## Integration phase

1. `pnpm install` if needed.
2. `pnpm typecheck` at repo root — MUST pass.
3. Smoke: `pnpm build` at repo root.
4. Commit with a single conventional commit message summarizing the remediation.

---

## Out of scope (deferred)

- Automated tests (template has none).
- Per-user JWT auth (spec §12.2).
- Persistent conversation history (spec §12.5).
- Full Jupiter instruction decomposition (simulation-based is sufficient).
