# Review Remediation — Design Doc

**Date:** 2026-04-16
**Companion to:** `REVIEW_REPORT.md`, `REVIEW_PLAN.md`

This document proposes a specific solution for each finding. Architectural items (C2, C3, H5) get deeper treatment because they touch multiple files and have tradeoffs worth making explicit.

---

## Architectural solutions

### C2 — Per-session state (foundational)

**Problem:** A single `PlexChatServer` holds `walletAddress`, `conversationHistory`, `isProcessing`, `isOwnerVerified`, `pendingTxResults`, `pendingMessages`, `currentAbortController` as instance fields. All broadcasts go to every connected client.

**Options considered:**
- **A. Per-connection fields on a `Session` class** — each `ws.on('connection')` creates a `Session`; handlers operate on the session; `session.send(msg)` replaces `broadcast`. ✓ Chosen.
- **B. Pass state through an argument on every method** — too invasive; every tool and handler plumbing explodes.
- **C. Keep shared state, document "single-user template"** — rejected. Spec §3.1 explicitly says "multi-user"; current design has an exploitable auth-bypass in autonomous mode (M4).

**Design:**
```ts
// new file: packages/server/src/session.ts
export class Session {
  readonly id: string;                              // ULID / random hex
  walletAddress: string | null = null;
  isOwnerVerified = false;
  conversationHistory: Array<{role, content}> = [];
  isProcessing = false;
  pendingTxResults: Array<{correlationId, signature}> = [];
  pendingMessages: Array<{content, senderName?, isSystem?}> = [];
  pendingTransactions: Map<correlationId, PendingTx> = new Map();
  currentAbortController: AbortController | null = null;

  constructor(public readonly ws: WebSocket) { this.id = randomId(); }

  send(msg: ServerMessage) { if (ws.readyState === OPEN) ws.send(JSON.stringify(msg)); }
  // no broadcast: every message is session-scoped
}
```

**Owner cache:** remains process-global (it's keyed by `agentAssetAddress`, not session).

**Migration:**
- `PlexChatServer` keeps: `wss`, `clients: Map<WebSocket, Session>`, `agent`, rate limiter map, ping interval.
- Every private method that today references `this.walletAddress` / `this.conversationHistory` / etc. takes a `session: Session` and operates on it.
- `broadcast()` is deleted. Every server→client emit is `session.send(...)`.
- `emitContext()` is emitted per-session (each session sees its own `walletAddress` and `connectedClients` total which is still global).

**Autonomous gate:** becomes `session.isOwnerVerified` — a non-owner connection can no longer inherit another session's verified state.

**Conversation history:** becomes per-session. Spec §6.7 will be updated to match.

### C3 — Transaction correlation + safe tx_result/tx_error

**Problem:** `tx_result`/`tx_error` are globally forgeable prompt-injection channels. Tool returns `{status:'pending'}` and the signature is never tied back to the originating call.

**Design:**

**1. Server-generated `correlationId` on every `transaction` event.**
```ts
// packages/server/src/session.ts (within Session):
async awaitTransaction(base64tx: string, meta?: {message?, index?, total?}): Promise<string> {
  const correlationId = randomId();
  this.send({ type: 'transaction', transaction: base64tx, correlationId, ...meta });
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      this.pendingTransactions.delete(correlationId);
      reject(new Error('Transaction approval timed out'));
    }, 5 * 60 * 1000);
    this.pendingTransactions.set(correlationId, { resolve, reject, timeout });
  });
}
```

**2. Client echoes `correlationId` in `tx_result`/`tx_error`.**
- Protocol types add `correlationId: string` to both (required).
- Old `tx_result` without `correlationId` is rejected with `error: 'missing correlationId'`.

**3. Server resolves/rejects the matching pending transaction.**
- `handleTxResult(session, { correlationId, signature })`: look up; if found, `pending.resolve(signature)`; clear timeout. Silently drop unknown IDs with an `error` event.
- `handleTxError(session, { correlationId, reason })`: look up; if found, `pending.reject(new Error(reason))`.
- No more synthetic `[System: …]` messages injected into the conversation history.

**4. Tool flow becomes truly awaitable.**
- `submitOrSend` (public mode branch) is changed:
```ts
// packages/shared/src/transaction.ts
const signature = await context.transactionSender.sendAndAwait(txBase64, {message, index, total});
return signature; // real signature string
```
- `TransactionSender` gains a `sendAndAwait` method that returns `Promise<string>`. The existing `sendTransaction` fire-and-forget method is removed.
- In `websocket.ts`, the `transactionSender` passed into `requestContext` calls `session.awaitTransaction(...)`.

**5. Error sanitization.**
- `tx_error.reason` is parsed by Zod (`z.string().max(200).regex(/^[\w\s.,:;'"()?!-]*$/)`) — if it doesn't match, rejected outright. No bracket, no newline, no injection surface.
- But the text is never fed back into the conversation as a `[System: …]` prefix — it becomes the `Error` object's message that the tool throws. The LLM sees it as a tool failure, which is safe.

**6. Autonomous-mode hygiene.**
- In autonomous mode, `session.awaitTransaction` is never called (tools go through `sendAndConfirm`). If a client sends `tx_result` in autonomous mode, server replies with an `error` event and drops.

### C4 — Abort signal wiring

**Design:**
- Pass `abortSignal: session.currentAbortController.signal` to `agent.stream(...)`.
- When `currentAbortController.abort()` is called, also call `reader.cancel()` inside the streaming loop so `await stream.text`/`stream.totalUsage`/`stream.finishReason` don't hang.
- In the outer `catch`, detect `AbortError` and treat as a clean shutdown (no error broadcast).
- In `finally`, always reset `isProcessing=false` and clear the controller.

### H5 — (rolled into C3)

Already subsumed by the correlation-ID design above. `submitOrSend` returns the real signature; tool returns it in its result.

---

## Security hardening

### C1 — Gitignore + secrets rotation

- Add `**/.env.local` and `**/.env.*.local` to `.gitignore`.
- Add note in README: "If you committed secrets, rotate them."
- **User action required:** rotate the actual Helius key and `WEB_CHANNEL_TOKEN` in the current `.env.local` file. (Code change can't rotate live keys.)

### H2 — Slippage and price-impact caps

- New env vars: `MAX_SLIPPAGE_BPS` (default 500), `MAX_PRICE_IMPACT_PCT` (default 2.0).
- `swap-token.ts`, `buyback-token.ts`, `sell-token.ts`: Zod `slippageBps.max(MAX_SLIPPAGE_BPS)` (read from config, so max is actually dynamic) — implemented as a runtime check in `execute`, because Zod schemas are built at module load.
- In `jupiter.ts:getQuote`, after receiving the quote, reject if `parseFloat(quote.priceImpactPct) > config.MAX_PRICE_IMPACT_PCT / 100`.
- Error messages: "Slippage 800 bps exceeds configured max of 500" — clear and actionable.

### H3 — Jupiter tx integrity check

- In `jupiter.ts:executeSwap`, after deserializing the transaction and before signing:
  - Extract required signers. Assert `umi.identity.publicKey` is the only required signer (no surprise co-signers).
  - If this fails, throw with detail; do not sign.
- This blocks the "Jupiter returns a tx that also asks another signer to authorize" attack. Deeper inspection (asserting mint flows) is deferred — it's complex, Jupiter uses many route programs, and the signer check captures the most dangerous classes.

### H4 — Cache only successful owner lookups

- `auth.ts:resolveOwner`: on `fetchAsset` failure, do not write to the cache. Next call retries.
- Add optional TTL (`OWNER_CACHE_TTL_MS`, default 5 minutes). Successful entries expire; next call re-fetches.

### M3 — AGENT_KEYPAIR format validation

- Zod `.refine` that either:
  - Base58 decodes to 64 bytes, OR
  - JSON-parses to a 64-length number array with all 0-255.
- Error: "AGENT_KEYPAIR must be a 64-byte base58 secret key or JSON byte array".

### M4 — LLM API key presence check

- After Zod parses config, parse provider prefix from `LLM_MODEL` (`anthropic`, `openai`, `google`, etc).
- Require corresponding env var: `anthropic → ANTHROPIC_API_KEY`, `openai → OPENAI_API_KEY`, `google → GOOGLE_GENERATIVE_AI_API_KEY`.
- Throw with a clear message if missing.

### M5 — Base58 validation for asset/token/override addresses

- Extend Zod refinement for `AGENT_ASSET_ADDRESS`, `AGENT_TOKEN_MINT`, `TOKEN_OVERRIDE`.

### M15 — Sanitize user content before injecting into prefix

- Strip `\n`, `\r`, `[`, `]` from the `[Agent: … | User wallet: …]` prefix input. Simpler than re-architecting to a system-role turn.
- Alternative considered: put status into `role: 'system'` in the message history — rejected because Mastra's system-role semantics are first-turn-only.

### L1/L2/L4/L11 — Misc input validation

- Split regex: `BASE58_ADDRESS_RE`, `BASE58_SIGNATURE_RE`.
- Add Zod regex to tool inputs (`destination`, `mint`, `address`, `signature`).
- `chat-message.tsx`: add `components={{ a: SafeLink }}` that blocks `javascript:` schemes and adds `rel="noopener noreferrer"`.
- Server: truncate unknown message-type echoes to 32 chars printable.

---

## Frontend UX

### H1 — Wire sendTxError

- `TransactionApproval` gains `onError(reason: string)` prop OR `onComplete({signature?, error?, correlationId})`.
- `page.tsx` on error/reject: `sendTxError(correlationId, reason)`; `setTxQueue([])` to abort multi-tx flow.
- The modal's reject branch becomes "reject → onComplete(null, err) → page.tsx clears queue + notifies server".

### M11 — Startup preflight

- Before `server.listen`, decode the keypair (already happens in Umi factory, but assert explicitly) and call `umi.rpc.getSlot()`.
- On failure, log the error and `process.exit(1)` so a bad config doesn't masquerade as a running server.

### M12 — Human-readable transaction summary

- In `transaction-approval.tsx`: deserialize the tx with `VersionedTransaction.deserialize`.
- Show: instruction count, total fee (pre-computed server-side via a `fee: number` field on `ServerTransaction`), top-level program IDs, any SystemProgram transfers' destinations and amounts.
- This is a best-effort preview, not a full decoder — the wallet provides canonical preview; this is a sanity check.

### M13 — Buffer outgoing while reconnecting

- `use-plexchat.ts`: maintain `outgoingQueueRef: Array<ClientMessage>`.
- `send()` pushes to the queue instead of returning no-op when `ws.readyState !== OPEN`.
- On `connected` event, flush the queue in order.
- Prevents silent drops of `message`, `tx_result`, `tx_error` during reconnect hiccups.

### M14 — Abort multi-tx queue on reject/error

- Rolled into H1. `setTxQueue([])` clears remaining queued txs when one fails.

### L5/L6 — Typing indicator hygiene

- `text_delta` handler: `setIsAgentTyping(false)`.
- `ws.onclose`: `setIsAgentTyping(false)`.

### L7 — Debug panel polish

- Persist `activeTab` to localStorage alongside `isOpen`.
- Server: emit `debug:generation_complete` in the error catch path with `finishReason: 'error'`.

---

## Protocol & server polish

### M2 — Add `tx_error` (and `correlationId`) to spec

- Update §6.3 table to include `tx_error`.
- Update Appendix A `ClientMessage` union.
- Document `correlationId` on `transaction`, `tx_result`, `tx_error`.

### M7 — Graceful shutdown

- `PlexChatServer.stop()`: clear `pingInterval`, iterate `clients`, clear each session's `aliveCheck` and abort its controller, `wss.close()`, close HTTP server.
- `server/src/index.ts`: register `SIGTERM`/`SIGINT` handlers that call `stop()` and `process.exit(0)`.

### M8 — Re-emit debug:context

- Call `emitContext(session)` in `ws.on('close')` (to update the count to the other clients?) — actually with per-session context, this is simpler: on disconnect, emit to remaining sessions a `debug:context` with updated `connectedClients`.
- On error in `handleChatMessage`, emit context one final time.

### M9 — Drain pendingMessages with while loop

- Change `if` to `while`.

### M10 — Token/tool-execution budget

- Add `MAX_TOKENS_PER_MESSAGE` (default 100k) and `MAX_TOOL_EXECUTIONS_PER_MESSAGE` (default 30).
- Track via the streaming `step-finish` chunks' `totalUsage` and tool-call count; abort if exceeded.
- Not a perfect budget but raises the bar against accidental runaway.

### L3 — Anchor state path

- `state.ts`: walk up from `cwd` but stop at the workspace root (look for `pnpm-workspace.yaml`). Beyond that, default to `cwd/agent-state.json`.

### L8 — Mutate tool instead of shallow spread

- `auth.ts:withAuth`: `tool.execute = wrappedExecute; return tool;` instead of `{...tool, execute}`.

### L9 — Warn on weak WEB_CHANNEL_TOKEN

- Zod refinement with `min(16)`; warn in console if under 32 chars.

### L12 — Funding amount as env var

- `AGENT_FUNDING_SOL` (default 0.02), `AGENT_FUNDING_THRESHOLD_SOL` (default 0.01). Read in `register-agent.ts`.

---

## Tool error handling (M16)

- Define `ToolError` codes (`INSUFFICIENT_FUNDS`, `INVALID_INPUT`, `RPC_FAILURE`, `UNAUTHORIZED`, `NOT_FOUND`, `TIMEOUT`, `GENERIC`).
- Every tool `catch` maps the error to a code + short message; the detailed `err` is `console.error`'d server-side only.
- Tool results return `{status:'error', code, message}`.
- The LLM sees `INSUFFICIENT_FUNDS: not enough SOL to cover fee` but never the raw RPC URL or internal addresses.

---

## Docs updates

- **SPEC.md §3.1** — soften "multi-user agents" claim OR keep it; now that per-session state is implemented, the spec matches.
- **SPEC.md §5.3** — update auth policy example with `ownerWallet !== null` guard.
- **SPEC.md §6.3 & Appendix A** — add `tx_error`, `correlationId`.
- **SPEC.md §6.7** — update to reflect per-session state.
- **SPEC.md §8.1** — add `MAX_STEPS`, `ENABLE_DEBUG_EVENTS`, `MAX_CONNECTIONS`, `MAX_SLIPPAGE_BPS`, `MAX_PRICE_IMPACT_PCT`, `AGENT_FUNDING_SOL`, `AGENT_FUNDING_THRESHOLD_SOL`, `OWNER_CACHE_TTL_MS`, `MAX_TOKENS_PER_MESSAGE`, `MAX_TOOL_EXECUTIONS_PER_MESSAGE`.
- **SPEC.md §12.6** — this becomes "wallet state is per-session" now (fixed, not a template limitation).
- **README.md** — regenerate project structure section; fix env-var table; update "Adding New Tools" example to match current `shared/` `public/` layout and full `AgentContext` shape.
- **.env.example** — mark REQUIRED/OPTIONAL; add blank entries for OPENAI / GOOGLE keys; add the new env vars; ensure ordering matches spec §8.1.

---

## Out of scope (for this pass)

- **H6 (launch-token multi-tx decomposition)** — Metaplex Genesis launch currently signs with agent keypair. Decomposing into 4 user-signed public-mode txs would require understanding the Genesis SDK's transaction graph and is a much larger change. **Decision: keep launch-token agent-signed; update spec §6.6 to note launch is agent-signed by design.** The multi-tx `index/total` fields remain available for future tools that need them.
- **Per-user JWT auth** — spec §12.2 already calls this out as a production deployment concern. The template's shared-token model is intentional.
- **Persistent conversation history** — spec §12.5 calls this out; out of scope.

---

## Dependencies between fixes

Phase 1 (sequential, foundational):
1. C1 — gitignore (trivial, isolate)
2. C2 — per-session state refactor (prerequisite for everything protocol-related)
3. C3 / H5 — correlation-ID tx plumbing (depends on C2)
4. C4 — abort signal wiring (depends on C2)
5. H1 — wire sendTxError from UI (depends on C3)

Phase 2 (4 parallel workstreams):
- **A. Security:** H2, H3, H4, M3, M4, M5, M15, L1, L2, L4, L11
- **B. Frontend UX:** M11 (preflight happens server-side but triggered from UI flow), M12, M13, L5, L6, L7 (UI half)
- **C. Docs/spec:** M1, M2, M6, L10, L13, SPEC.md edits, README edits, .env.example rewrite
- **D. Server polish:** M7, M8, M9, M10, M16, L3, L7 (server half), L8, L9, L12

Phase 3: final integration + typecheck + smoke tests.
