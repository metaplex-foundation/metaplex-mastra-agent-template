# Review v2 Remediation — Design Doc

**Date:** 2026-04-17
**Companion to:** `docs/REVIEW_REPORT_V2.md`
**Scope:** Fix all Critical and High findings; address most Medium; defer ornamental Low items.

This document proposes a specific solution for each finding, groups them into independent workstreams that can be executed in parallel, and calls out the design tradeoffs for items that touch multiple files.

---

## Overall strategy

Four workstreams that can be implemented in parallel once the foundational shared changes land:

- **Foundation (sequential, first):** shared config + protocol type changes + a small `utils/context.ts` helper. Everything else depends on these.
- **Workstream A — Server hardening:** C1, C2, C5, H4 (register lock), H8, M1, M3, M5, M10, L6.
- **Workstream B — Tools correctness:** C4 (launch-token), C6 (Jupiter tx integrity), H1 (status field), H2 (amount validation), H5 (sleep abort), M8 (shared context helper), M13 (confirm input), H4 (owner single-flight + H3 cache).
- **Workstream C — Frontend UX/a11y:** C3 (Authorization header via subprotocol), H6 (4001 close), H7 (modal a11y), M9 (explorer cluster env), M11 (beforeunload), M12 (responsive panel), L1–L5.
- **Workstream D — Docs & protocol:** update SPEC.md §3.1/§10.4 for launch-token design decision, WEBSOCKET_PROTOCOL.md `jid` clarification, README env var table.

---

## Design decisions

### C4 launch-token: keep agent-signed, update docs

**Options:**
1. **Decompose Genesis into public-mode user-signed txs.** Rejected — Genesis SDK composes many internal instructions; the SDK returns full signed txs by design. Rebuilding from scratch would duplicate a third-party SDK and keep breaking on Genesis upgrades.
2. **Keep agent-signed in both modes, amend spec.** Chosen. The agent pays the launch cost and creates the token; the user doesn't need to sign. This is consistent with the unified identity model (both modes have a keypair). In public mode, the user simply chats with the agent and the agent acts on its own authority.
3. **Disable launch-token in public mode entirely.** Rejected — breaks the "token launch assistant" use-case called out in §3.1.

**Action:** update SPEC §3.1, §5.1, §6.6, §10.4 to explicitly say "launch-token is agent-signed in both modes (the agent pays, not the user)." Add `confirmIrreversible: true` input to `launch-token` for belt-and-braces safety (M13).

### C3 Authorization token in client bundle

**Options:**
1. **Switch to WebSocket subprotocol auth.** Use the `Sec-WebSocket-Protocol` header (`new WebSocket(url, ["bearer", token])`) — the token is sent in the handshake, not the URL, and not logged by most reverse proxies. Server parses `Sec-WebSocket-Protocol` and verifies. Chosen.
2. **Proxy WS through Next.js API route with session cookie.** Rejected for this template — adds significant complexity for a test UI. Documented as production recommendation instead.
3. **Leave as-is, document risk.** Rejected — the prior audit already flagged it; we can improve with option 1 cheaply.

**Action:** server accepts token from `Sec-WebSocket-Protocol` header (first subprotocol); UI sends it via subprotocol instead of query. Query param remains supported for backwards compat + curl convenience, but the UI stops using it.

### C5 Owner TOCTOU

**Options:**
1. **Re-resolve on every autonomous message.** Simple, relies on cache so almost-free. Chosen.
2. **Invalidate session flag when cache entry expires.** More complex; doesn't help if cache is never re-fetched.

**Action:** in `websocket.ts` autonomous gate, also call `resolveOwner()` and compare with `session.walletAddress` on every `message` (not just `wallet_connect`). Cache makes this ~O(1).

### C6 Jupiter integrity — depth of check

**Options:**
1. **Full instruction decomposition + mint/amount verification.** Reliable but requires parsing SPL TokenSwap, Raydium, Orca, Serum, Meteora instruction layouts (Jupiter routes through any of them). Hundreds of lines of code and will drift.
2. **Pre-swap balance snapshot + post-swap delta assertion.** Sign a simulated tx first, look at pre/post token balances via `simulateTransaction`, assert `deltaIn ≤ params.amount && deltaOut > 0 && deltaOut ≥ expectedMin`. Works regardless of which DEX Jupiter routes through. Chosen.
3. **Trust Jupiter, add caps elsewhere.** Current state; insufficient.

**Action:** add `simulateAndVerifySwap()` helper in `jupiter.ts`. Before signing: run `rpc.simulateTransaction` (with `replaceRecentBlockhash` to avoid expiry during sim), scan pre/post token balances for the agent's wallet, assert input debit bounded by `params.amount` and output credit ≥ `expectedMinOutAmount` (already returned by Jupiter quote). Reject on mismatch.

### H7 Modal accessibility

Use a lightweight in-component focus trap + ESC handler — no new dependency. Focus first Approve button on open; trap Tab between "Approve" and "Reject"; return focus to the trigger on close; `role="dialog" aria-modal="true" aria-labelledby aria-describedby`; backdrop click → reject.

### H4 Register-agent idempotency

**Options:**
1. **Module-level singleton promise.** If a registration is in-flight, second caller awaits the same promise. Chosen.
2. **State-file lock.** Would need filesystem mutex; overkill for single-process template.

**Action:** `register-agent.ts` gains a module-scoped `inflightRegistration: Promise<Result> | null`. On entry, if set, await and return its result; else create, store, clear in `finally`.

### H3 Pre-registration owner cache

**Action:** `resolveOwner` skips caching when `assetAddress === null`. Bootstrap fallback always re-reads env, never stale.

### Error shape standardization (H1 + implicit consistency)

Define shared `ToolResult<T>` in `packages/shared/src/types/tool-result.ts`:

```typescript
export type ToolResult<T = Record<string, unknown>> =
  | ({ status: 'success' } & T)
  | { status: 'error'; code: ToolErrorCode; message: string };
```

Every tool return now uses this shape. Output schema becomes `z.union([successSchema, errorSchema])` or we keep loose `z.any()` — the latter is simpler and Mastra doesn't validate output strictly.

---

## Workstream A — Server hardening

### A1. Wallet-address sanitization in chat prefix (C1)
**File:** `packages/server/src/websocket.ts:477–478`
**Change:** define `sanitizeForPrefix(s: string): string` that strips `[`, `]`, `\r`, `\n`, caps at 88 chars. Apply to both `session.walletAddress` and the agent status string. Even better: move the status into a Mastra `RequestContext` field so it never enters the user-role message at all. Given Mastra's `generate()` signature already accepts requestContext, we already have this — so we'll inject `[Agent: registered…]` as a *system* role message on first turn, not as a user prefix.
- Implement as a `buildUserPrefix(session)` returning sanitized `[Agent:…]` with the wallet address escaped. Minimal diff.

### A2. WebSocket origin validation (C2)
**File:** `packages/server/src/websocket.ts:109–116`
**Change:** new env var `WS_ALLOWED_ORIGINS` (comma-separated list, default `http://localhost:3001,http://localhost:3000`). Add `verifyClient` callback that extracts `info.req.headers.origin` and rejects if not in list. In dev/missing env, allow `undefined` origin (curl, WS CLIs) with a warning log.

### A3. Subprotocol auth support (C3, server side)
**File:** `packages/server/src/websocket.ts` connection auth block
**Change:** accept token from any of (1) query `?token=`, (2) `Authorization: Bearer`, (3) `Sec-WebSocket-Protocol: bearer, <token>`. On accept, echo the `bearer` subprotocol back to the client so the handshake succeeds.

### A4. Autonomous TOCTOU close (C5)
**File:** `packages/server/src/websocket.ts:306–319`
**Change:** in the autonomous gate, before running an LLM turn, re-resolve owner: if `session.walletAddress !== await resolveOwner(...)`, reject and clear `isOwnerVerified`.

### A5. Register-agent single-flight lock (H4, server-impacted portion)
Implemented in tools workstream (`register-agent.ts`), no server change needed.

### A6. Error-without-close WS race (H8)
**File:** `packages/server/src/websocket.ts:219–223`
**Change:** on `error`, call `ws.terminate()` to guarantee cleanup also runs via `close`. Move cleanup into a single `cleanupSession(ws)` idempotent helper called from both handlers.

### A7. Protocol `jid` (M1)
**File:** `packages/server/src/websocket.ts:239` OR `WEBSOCKET_PROTOCOL.md`
**Change:** chose code side — update `WEBSOCKET_PROTOCOL.md` to reflect per-session `jid` (better semantics). Keep the `web:${session.id}` format in code.

### A8. Per-message size cap (M3)
**File:** `packages/server/src/websocket.ts:432+`
**Change:** new const `MAX_MESSAGE_CONTENT = 8000`. Reject with error event if `message.content.length > MAX_MESSAGE_CONTENT`.

### A9. Tool execution concurrency cap (M5)
**File:** `packages/shared/src/server-limits.ts` + `packages/server/src/websocket.ts`
**Change:** introduce a per-session semaphore that bounds in-flight tool executions at 3. Intercept tool calls in the Mastra stream tool-call event — if > 3 pending, delay with small jitter. Simpler alternative: rely on serial execution (Mastra executes tool calls serially in one turn by default) and instead enforce cumulative RPC wall-clock budget per message via a running timer that calls `abortController.abort()`.
- Chosen: cumulative budget, simpler and more robust.

### A10. Late tx_result reconciliation (M10)
**File:** `packages/server/src/websocket.ts:382–388`
**Change:** on unknown correlationId received, if `signature` is valid base58, log as `late-ok` and drop silently (don't send error to the client). Don't re-process since the tool already threw.

### A11. Auth failure telemetry (L6)
**File:** `packages/server/src/websocket.ts`
**Change:** `console.warn` every token mismatch, origin rejection, autonomous-gate denial, or rate-limit breach with IP (best-effort), timestamp, session id, reason. Opt-in via `LOG_AUTH_FAILURES=true` (default true).

---

## Workstream B — Tools correctness

### B1. Launch-token: confirmation input + docs (C4, M13)
**File:** `packages/core/src/tools/shared/launch-token.ts`
**Change:** add required `confirmIrreversible: z.literal(true)` input. Return consistent `{status:'success', ...}` or `{status:'error', code:'INVALID_INPUT', message:...}`. No change to signing behavior (agent signs per design). SPEC update handled in Workstream D.

### B2. Jupiter swap simulation integrity (C6)
**File:** `packages/shared/src/jupiter.ts`
**Change:** new helper `simulateAndVerifySwap(umi, tx, expected: {inputMint, amount, outputMint, minOut})`. Uses `rpc.call('simulateTransaction', [base64Tx, {encoding:'base64', replaceRecentBlockhash:true, sigVerify:false, accounts: {encoding: 'base64', addresses: [<agent input ATA>, <agent output ATA>]}}])`. Parses returned `accounts[].data` for token balances pre/post; computes delta; rejects if:
- `inputDelta > params.amount * (1 + slippage)` (some buffer for fees)
- `outputDelta < minOut * (1 - epsilon)`
- any other token account owned by agent had unexpected movement

Simpler fallback: use `getTokenAccountBalance` for the two ATAs just before `sendAndConfirm`, call `simulateTransaction` with `accounts` to get the post-sim balances, compute delta. Done.

### B3. Tool output shape consistency (H1)
**Files:**
- `packages/core/src/tools/shared/register-agent.ts:144`
- `packages/core/src/tools/shared/delegate-execution.ts:87, 114`
- `packages/core/src/tools/shared/launch-token.ts:45, 54, 64, 109`
- audit all shared/public tools for early-return paths

**Change:** add `status: 'success'` or `status: 'skipped' | 'already_done' | 'error'` on every return. Centralize via `packages/shared/src/types/tool-result.ts`. Update each tool to use the typed helper `ok({...})` / `err(code, message)`.

### B4. Amount validation (H2)
**Files:** `swap-token.ts:26`, `sell-token.ts:18–20`
**Change:** switch both to `.string().regex(/^\d+(\.\d+)?$/).refine((s) => Number(s) > 0, 'amount must be positive')` OR converge on `z.number().positive()` — the tools currently accept strings because Jupiter wants raw integer lamport/base units and JS loses precision > 2^53. Keep string but add regex + positivity refine. Also in `buyback-token.ts:18–21`, keep `z.number().positive()` but add `.finite()`.

### B5. Sleep abort interruption (H5)
**File:** `packages/core/src/tools/shared/sleep.ts`
**Change:** thread an `AbortSignal` via `RequestContext` set from the server on each stream. Implement sleep as:
```ts
await new Promise((resolve, reject) => {
  const t = setTimeout(resolve, seconds * 1000);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Sleep aborted')); }, { once: true });
});
```

### B6. Owner cache single-flight + no bootstrap caching (H3, H4 owner part)
**File:** `packages/shared/src/auth.ts`
**Change:**
1. Module-scoped `inflightLookups = new Map<string, Promise<CachedOwner>>()`. On cache-miss, check map first. Store the promise; resolve/delete in `finally`.
2. When `assetAddress === null`, don't cache — just return `{owner: OWNER_WALLET || null}`. Env-var rotation becomes immediate.

### B7. Register-agent single-flight (H4)
**File:** `packages/core/src/tools/shared/register-agent.ts`
**Change:** module-scoped `inflightRegistration: Promise<ToolResult> | null = null`. On entry, return `inflightRegistration` if set; else create, assign, clear in finally. Prevents double-funding race.

### B8. Shared `readAgentContext` helper (M8)
**File:** `packages/shared/src/context.ts` (new)
**Change:** export `readAgentContext(ctx: RequestContext): AgentContext`. Use it in `transfer-sol.ts`, `transfer-token.ts`, and any other tool that manually composes the shape.

---

## Workstream C — Frontend UX/a11y

### C1f. Authorization via subprotocol (C3 client side)
**File:** `packages/ui/src/hooks/use-plexchat.ts`
**Change:** `new WebSocket(url, ['bearer', token])` instead of `new WebSocket(urlWithToken)`. Drop the `?token=` query builder.
**File:** `packages/ui/src/app/env.ts` — remove `token` from URL; add token helper export.

### C2f. Close code 4001 stop reconnect (H6)
**File:** `packages/ui/src/hooks/use-plexchat.ts:203–217`
**Change:** in onclose, if `event.code === 4001`, set `intentionalCloseRef.current = true`, surface `error: 'Unauthorized'`, do not restart reconnect timer.

### C3f. Modal accessibility (H7)
**File:** `packages/ui/src/components/transaction-approval.tsx`
**Change:**
1. Add `role="dialog" aria-modal="true" aria-labelledby="tx-title" aria-describedby="tx-desc"`.
2. `onKeyDown` at modal root: Escape → `handleReject()`; Tab loops between Approve/Reject using a small focus-trap (two refs + first/last tab interception).
3. Backdrop onClick: if `e.target === e.currentTarget`, call `handleReject()`.
4. On mount, focus Approve button. On unmount, focus the element that was focused at mount time (`document.activeElement`).
5. Add `tabIndex={-1}` to the modal root and wire focus to it.

### C4f. Explorer cluster env (M9)
**File:** `packages/ui/src/app/env.ts` + `transaction-approval.tsx:190–194`
**Change:** add `NEXT_PUBLIC_SOLANA_CLUSTER` (`mainnet-beta | devnet | testnet`). Default `devnet`. Explorer URL uses it directly.

### C5f. Beforeunload guard (M11)
**File:** `packages/ui/src/app/page.tsx`
**Change:** `useEffect` registering `beforeunload` listener that sets `event.returnValue` when `txQueue.length > 0`.

### C6f. Responsive debug panel (M12)
**File:** `packages/ui/src/app/page.tsx:106`
**Change:** panel class becomes `hidden md:block md:w-[400px]` on small screens; panel toggle hides it entirely on mobile; or add `w-full md:w-[400px]` with an overlay mode on mobile.

### C7f. Small polish (L1–L5)
- L1: header wraps with `flex-wrap` + `gap-2`.
- L2: wrap chat messages with `max-w-3xl mx-auto`.
- L3: debounce suggestion buttons (`disabled` while WS not ready + 300ms guard).
- L4: wrap localStorage calls in try/catch with console.warn fallback.
- L5: remove inline cursor when `isStreaming=false`.

---

## Workstream D — Docs & protocol

### D1. Update SPEC.md for launch-token design (C4)
- §3.1: "Public mode — user signs their own transactions" → add sentence "Except `launch-token`, which is always agent-signed (see §10.4)."
- §5.1: mark `launch-token` with a footnote "agent-signed in both modes."
- §6.6 & §10.4: clarify.

### D2. Update SPEC.md §8.1 env var table
- Add `WS_ALLOWED_ORIGINS`.
- Add `LOG_AUTH_FAILURES`.
- Add `NEXT_PUBLIC_SOLANA_CLUSTER` under §8.2.
- Add `MAX_MESSAGE_CONTENT`.
- Add `MAX_RPC_TIME_BUDGET_MS` (if we use the budget approach for A9).

### D3. Update WEBSOCKET_PROTOCOL.md
- `jid` per-session (matches code).
- Subprotocol auth option documented.
- `bearer` subprotocol name.

### D4. Update README.md
- Env var additions, subprotocol auth note.

### D5. Update .env.example
- Match new env vars.

---

## Dependencies between fixes

**Phase 1 (foundational, sequential):**
- Shared types: `packages/shared/src/types/tool-result.ts`.
- Shared helper: `packages/shared/src/context.ts` (readAgentContext).
- Config additions: `WS_ALLOWED_ORIGINS`, `LOG_AUTH_FAILURES`, `MAX_MESSAGE_CONTENT`.

**Phase 2 (parallel workstreams):**
- A (Server)
- B (Tools)
- C (Frontend)
- D (Docs)

**Phase 3: integration**
- `pnpm typecheck` across packages.
- Smoke test both modes end-to-end (manual — no automated tests in template).

---

## Out of scope for this pass

- Per-user JWT auth (spec §12.2 already calls this out).
- Persistent conversation history (spec §12.5).
- Mobile-native client.
- Full Jupiter route instruction decomposition (simulation-based check is sufficient).
- Automated test suite (template has none; adding a framework is a separate initiative).
