# Review Remediation — Implementation Plan

**Date:** 2026-04-16
**Companion to:** `REVIEW_REPORT.md`, `REVIEW_DESIGN.md`

Execution strategy: two sequential foundation phases (which must be done in order because they touch shared plumbing), then a parallel workstream phase, then integration.

---

## Phase 1 — Foundation (sequential, done by main agent)

### Step 1.1 — C1: gitignore + secrets
- Edit `.gitignore`: add `**/.env.local` and `**/.env.*.local`.
- Verify with `git check-ignore packages/ui/.env.local` returns the path.
- Note in report that the user must rotate live secrets (we can't do that).

### Step 1.2 — C2: per-session state refactor
- Create `packages/server/src/session.ts` exporting a `Session` class.
  - Fields: `id`, `ws`, `walletAddress`, `isOwnerVerified`, `conversationHistory`, `isProcessing`, `pendingTxResults`, `pendingMessages`, `pendingTransactions: Map<correlationId, PendingTx>`, `currentAbortController`, `aliveCheck` interval.
  - Method: `send(msg)` writes to `ws` if open.
- Refactor `packages/server/src/websocket.ts`:
  - `clients: Set<WebSocket>` → `sessions: Map<WebSocket, Session>`.
  - Every handler takes `session` (or looks up by `ws`).
  - `broadcast()` removed; replaced with `session.send(msg)`.
  - Autonomous gate checks `session.isOwnerVerified`.
  - `emitContext(session)` is per-session.
  - Connection close: remove session from map, clear its interval, reject its pending transactions.

### Step 1.3 — C3 / H5: transaction correlation
- Update `packages/shared/src/types/protocol.ts`:
  - `ServerTransaction` adds required `correlationId: string`, optional `fee?: number`.
  - `ClientTxResult` adds required `correlationId: string`.
  - `ClientTransactionError` adds required `correlationId: string`, renames `error` → `reason`, adds `.max(200)` + charset regex.
- Update `packages/shared/src/types/agent.ts`:
  - `TransactionSender` gains `sendAndAwait(base64, meta) → Promise<string>`; remove old `sendTransaction`.
- Update `packages/shared/src/transaction.ts`:
  - `submitOrSend` public branch: `return await context.transactionSender.sendAndAwait(txBase64, {message, index, total})`.
  - Tool's returned result now includes the real signature.
- Update `packages/server/src/websocket.ts`:
  - `Session.awaitTransaction(base64, meta)`: generates correlationId, sends transaction event, registers pending with 5-min timeout, returns promise.
  - `handleTxResult({correlationId, signature})`: look up; resolve; else emit `error` event.
  - `handleTxError({correlationId, reason})`: look up; reject with sanitized reason; else emit error.
  - Delete the `[System: …]` synthetic injection paths.
  - Autonomous mode: reject `tx_result`/`tx_error` with an error event.

### Step 1.4 — C4: abort signal wiring
- In `handleChatMessage`, pass `abortSignal: session.currentAbortController.signal` to `agent.stream`.
- In the streaming loop, when `signal.aborted`, call `reader.cancel()` and break.
- In the outer catch, detect `AbortError` (name === 'AbortError') and skip error-broadcast.

### Step 1.5 — H1: wire sendTxError + clear queue from UI
- Update `packages/ui/src/hooks/use-plexchat.ts`:
  - `sendTxResult(correlationId, signature)` (add param).
  - `sendTxError(correlationId, reason)` (make callable from outside; export on hook return).
  - Incoming `transaction` messages carry `correlationId`; stored on queue entries.
- Update `packages/ui/src/components/transaction-approval.tsx`:
  - `onComplete({signature?, error?})` signature.
  - Reject branch calls `onComplete({error: 'User rejected transaction', correlationId})`.
  - `handleApprove` catch calls `onComplete({error: err.message, correlationId})`.
- Update `packages/ui/src/app/page.tsx`:
  - `onComplete` branches: success → `sendTxResult(correlationId, sig)` + shift queue; error → `sendTxError(correlationId, error)` + `setTxQueue([])` (abort multi-tx flow).

**Checkpoint:** typecheck, manual flow verification.

---

## Phase 2 — Parallel workstreams (4 subagents)

Each subagent operates on its own set of files. Conflicts minimized by file-set ownership:

### Workstream A — Security hardening
Owner files:
- `packages/shared/src/config.ts`
- `packages/shared/src/auth.ts`
- `packages/shared/src/jupiter.ts`
- `packages/core/src/tools/shared/{swap,buyback,sell}-token.ts`
- `packages/core/src/tools/public/transfer-*.ts` (Zod regex only)
- `packages/shared/src/state.ts` (L3)
- `packages/ui/src/components/chat-message.tsx` (L4)

Tasks: H2 (slippage), H3 (jupiter signer check), H4 (cache only successes), M3 (keypair format), M4 (LLM API key check), M5 (base58 regex), M15 (bracket sanitize in websocket prefix — coordinate with D), L1 (split regex), L2 (tool zod regex), L4 (safe markdown links), L8 (withAuth mutate-in-place), L9 (min token length).

### Workstream B — Frontend UX
Owner files:
- `packages/ui/src/hooks/use-plexchat.ts` (reconnect buffering)
- `packages/ui/src/hooks/use-debug-panel.ts` (persist activeTab)
- `packages/ui/src/components/transaction-approval.tsx` (human-readable summary)
- `packages/ui/src/components/typing-indicator.tsx` (no change) + use site (typing hygiene)
- `packages/ui/src/components/chat-panel.tsx` (wrap fix)
- `packages/ui/src/components/chat-message.tsx` (break-words on agent bubbles)

Tasks: M12 (tx summary), M13 (reconnect buffer), L5 (clear typing on text_delta), L6 (clear typing on close), L7-UI (persist activeTab).

### Workstream C — Docs, spec, env
Owner files:
- `docs/SPEC.md`
- `README.md`
- `.env.example`
- `packages/ui/.env.local.example`

Tasks: M1 (add env vars to spec + .env.example), M2 (add tx_error, correlationId to spec), M6 (README refresh), L10 (env.example markers), L13 (spec auth policy example).

### Workstream D — Server polish
Owner files:
- `packages/server/src/websocket.ts` (surgical additions — not the full refactor, which is Phase 1)
- `packages/server/src/index.ts`
- `packages/shared/src/config.ts` (new env vars only — coordinate with A)
- All `packages/core/src/tools/shared/*.ts` (error codes — M16)
- `packages/core/src/tools/shared/register-agent.ts` (L12)

Tasks: M7 (graceful shutdown), M8 (emitContext re-emit), M9 (while drain), M10 (token/tool budget), M16 (error codes), L7-server (generation_complete on error), L11 (cap unknown message echo), L12 (funding env vars).

---

## Phase 3 — Integration + verification

- `pnpm typecheck` across all packages
- `pnpm build` across all packages
- Smoke test plan (manual, documented in final handoff):
  - Start server + UI, verify console output (preflight log, Test UI URL).
  - Connect wallet, send "check my balance", verify response.
  - Attempt `transfer-sol` with small amount, verify tx approval modal shows decoded summary, approve, verify agent receives signature.
  - Reject a tx, verify agent gets error and clears queue.
  - Toggle `AGENT_MODE=autonomous`, verify only owner can connect; verify second connection without wallet is rejected.
  - Force RPC URL to garbage, verify startup exits with clear error.

---

## Rollback plan

- Each phase is one or more git commits on `main`.
- If Phase 2 causes regressions, `git revert` the offending commit(s); Phase 1 stands alone and is independently valuable.

---

## Acceptance criteria per finding

- C1: `.env.local` is gitignored; `git check-ignore` confirms.
- C2: `grep -n 'this.walletAddress\|this.conversationHistory\|this.isProcessing\|this.isOwnerVerified' packages/server/src/websocket.ts` returns nothing; all are on `session`.
- C3: `grep -n 'correlationId' packages/shared/src/types/protocol.ts` shows the field on `ServerTransaction`, `ClientTxResult`, `ClientTransactionError`. `grep -n '\[System:' packages/server/src/websocket.ts` returns 0 matches in `handleTxResult`/`handleTxError`.
- C4: `agent.stream` is called with `abortSignal:`.
- H1: `grep -n 'sendTxError' packages/ui/src/app/page.tsx` finds the call site.
- H2: `packages/shared/src/config.ts` contains `MAX_SLIPPAGE_BPS`; swap tools reject above it.
- H3: `packages/shared/src/jupiter.ts:executeSwap` asserts required-signer set.
- H4: `packages/shared/src/auth.ts:resolveOwner` doesn't cache on fetch error.
- All Phase 2 findings: file-level grep / typecheck / build passes.
