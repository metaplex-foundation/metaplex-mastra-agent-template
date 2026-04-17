# Comprehensive Project Audit Report

**Date:** 2026-04-16
**Auditor:** Claude Opus 4.6
**Scope:** Full codebase review against SPEC.md — architecture, security, UX, spec compliance

---

## Overall Verdict

The codebase is in **excellent spec compliance** (180/184 verifiable claims pass). The architecture is clean, the tool inventory is complete, and the protocol implementation is thorough. However, the review uncovered **significant findings** across security, reliability, and UX quality that should be addressed before this template is used in any real-world setting.

---

## CRITICAL FINDINGS (3)

### C-1: No WebSocket Rate Limiting, Connection Limits, or Message Size Limits
**File:** `packages/server/src/websocket.ts`

The server has zero abuse protection:
- No connection limit — `clients` Set grows unboundedly
- No message rate throttle — a client can flood thousands of messages/sec
- No message size limit — `ws` library defaults allow ~100MB messages
- No conversation history cap — the full history array is sent to the LLM on every turn, so an attacker can inflate API costs unboundedly

**Impact:** Denial of service via memory exhaustion and financial DoS via LLM API cost inflation.

### C-2: Prompt Injection via User Messages and Wallet Address
**File:** `packages/server/src/websocket.ts:191-197`

User-controlled content is injected directly into the LLM's conversation context without sanitization:
- Chat messages are prepended with system-like metadata brackets
- The `wallet_connect` handler accepts any string as an address (no base58 validation) — an attacker can set `walletAddress` to a prompt injection payload that gets prepended to every subsequent message
- `tx_result` signatures are injected into a system message without validation

**Impact:** In autonomous mode, an attacker could manipulate the agent into executing unauthorized financial transactions (swaps, sells, token launches).

### C-3: WebSocket Auth Token Exposed in Client JavaScript Bundle
**File:** `packages/ui/src/app/env.ts`

The `NEXT_PUBLIC_WS_TOKEN` is bundled into the browser JavaScript and placed in the WebSocket URL as a cleartext query parameter. Since this is the sole authentication mechanism, anyone who loads the page can extract the token and connect independently.

**Impact:** The authentication model is effectively nullified for any deployment where the UI is publicly accessible.

---

## HIGH FINDINGS (10)

### H-1: Jupiter Price API Response Shape Is Wrong — `get-token-price` Is Non-Functional
**File:** `packages/core/src/tools/shared/get-token-price.ts:43-47`

The code casts the Jupiter Price API v3 response as `Record<string, { usdPrice: number }>`, but the actual response nests results under a `data` key with a `price` string field (not `usdPrice` number). As written, `priceUsd` will **always be null**. This breaks the price watching and portfolio analysis workflows described in the system prompt.

### H-2: `bs58` Used in `delegate-execution` But Not Declared in `package.json`
**File:** `packages/core/src/tools/shared/delegate-execution.ts:13`

Phantom dependency — works only because of `shamefully-hoist=true`. Will break if hoisting changes or the package is used outside this monorepo. Other files (like `register-agent`) correctly use `base58` from `@metaplex-foundation/umi/serializers`.

### H-3: `tx_result` Handler Has Hardcoded "Funding Transaction" Semantics
**File:** `packages/server/src/websocket.ts:139-147`

The system message injected when a `tx_result` arrives always says "the user approved the funding transaction" and instructs retry of registration+delegation. This is wrong for any other transaction type (swaps, transfers, token launches). The agent receives misleading context.

### H-4: No Transaction Correlation Between Sent and Received Results
**File:** `packages/server/src/websocket.ts`

There is no correlation ID linking a sent `transaction` message to a received `tx_result`. If multiple transactions are in flight, there is no way to know which one the signature corresponds to.

### H-5: Single-Slot `pendingTxResult` Drops Multi-Transaction Results
**File:** `packages/server/src/websocket.ts:28`

`pendingTxResult` is a single `string | null`. If two `tx_result` messages arrive while the agent is processing, the first is silently lost. This is a data loss bug for multi-transaction flows (e.g., token launch = 4 txs).

### H-6: Concurrent Chat Messages Not Queued — Race Conditions
**File:** `packages/server/src/websocket.ts`

The `isProcessing` flag only gates `tx_result`, not regular chat messages. Two simultaneous `handleChatMessage` calls race on `conversationHistory` and produce interleaved, unpredictable broadcasts.

### H-7: Shared Global Wallet State Allows Cross-Client Override
**File:** `packages/server/src/websocket.ts:24`

Any connected client can call `wallet_connect` with an arbitrary address, replacing the wallet for all clients. No per-connection isolation.

### H-8: Debug Events Broadcast Sensitive Tool Arguments/Results to All Clients
**File:** `packages/server/src/websocket.ts:229-248`

`debug:tool_call` (with full arguments) and `debug:tool_result` (with full results) are broadcast to every connected client. This leaks balance info, transaction signatures, swap details, and internal error messages.

### H-9: No Origin Validation on WebSocket Connections
**File:** `packages/server/src/websocket.ts`

No `verifyClient` origin check. Combined with the token being in the client JS bundle (C-3), any malicious webpage can connect.

### H-10: `executeSwap` Blockhash Confirmation Race Condition
**File:** `packages/shared/src/jupiter.ts:117-124`

After sending a Jupiter swap transaction, the code fetches a **new** blockhash for confirmation instead of using the one embedded in the transaction. This creates a window where the confirmation strategy's block height doesn't match the actual transaction's validity window, potentially causing premature "expired" errors or false success.

---

## MEDIUM FINDINGS (16)

| # | Finding | File | Summary |
|---|---------|------|---------|
| M-1 | `launch-token` missing `updateConfigFromState()` | `core/tools/shared/launch-token.ts:104` | After persisting `agentTokenMint` to state file, the in-memory config is not updated. Token mint invisible to config readers until restart. |
| M-2 | Read-only tools have no try/catch | `core/tools/shared/get-balance.ts` et al. | Invalid addresses or RPC failures produce cryptic unhandled errors to the LLM. Compare with `get-token-metadata` which has proper error handling. |
| M-3 | State file race condition on concurrent writes | `shared/src/state.ts:56-60` | Non-atomic read-modify-write. Two concurrent `setState` calls can lose data. |
| M-4 | Config merges state values without validation | `shared/src/config.ts:54-60` | State-to-config overlay bypasses Zod schema — corrupted `agent-state.json` could inject arbitrary strings. |
| M-5 | `AGENT_FEE_SOL` has no min/max bounds | `shared/src/config.ts:31` | Accepts negative values or astronomically large values. A fee of `999999` SOL would drain the user's wallet. |
| M-6 | No `ClientTransactionError` protocol message | `shared/src/types/protocol.ts` | If the user rejects a transaction in their wallet, there is no way for the client to report this back. The agent waits indefinitely. |
| M-7 | `executeSwap` is always autonomous — no public mode support | `shared/src/jupiter.ts:101-132` | Always signs with agent keypair. In public mode, users expect their wallet for swaps, but this isn't possible due to Jupiter's versioned transaction format. Needs documentation in the system prompt. |
| M-8 | Transaction confirmation timeout missing in UI | `ui/components/transaction-approval.tsx:77` | Uses deprecated `confirmTransaction` signature without timeout/strategy. UI can hang permanently in "Confirming..." state. |
| M-9 | Single pending transaction in UI overwrites queue | `ui/src/app/page.tsx:41` | Only one `pendingTx` tracked. Second transaction overwrites the first before user can approve it. |
| M-10 | Auto-close timer not cleaned on unmount | `ui/components/transaction-approval.tsx:80` | `setTimeout(() => onComplete(sig), 2000)` fires after unmount, mutating parent state. |
| M-11 | No WebSocket error event handler | `server/src/websocket.ts` | No `ws.on('error')` or `wss.on('error')`. Unhandled socket errors could crash the process. |
| M-12 | No ping/pong heartbeat for stale connection detection | `server/src/websocket.ts` | Silently dropped connections remain in `clients` Set indefinitely — memory leak. |
| M-13 | Stream errors pushed to conversation history as assistant messages | `server/src/websocket.ts:305-314` | Error messages in history confuse the LLM on subsequent turns. |
| M-14 | No stream cancellation when all clients disconnect | `server/src/websocket.ts` | If everyone disconnects mid-stream, the LLM call continues to completion, wasting API tokens. |
| M-15 | `maxSteps: 10` is hardcoded | `server/src/websocket.ts:205` | Complex multi-tool chains may need more steps. Should be configurable. |
| M-16 | Transfer tool descriptions reference autonomous mode but are public-only | `core/tools/public/transfer-sol.ts:18` | Tool descriptions shown to the LLM mention "autonomous mode" but these tools are never available in that mode. Misleading. |

---

## LOW FINDINGS (14)

| # | Finding | Summary |
|---|---------|---------|
| L-1 | `createUmi()` creates new instance per tool call | No caching. Each tool re-parses the keypair and opens new HTTP connections. |
| L-2 | Duplicate workspace root logic | `config.ts` and `state.ts` each walk the directory tree independently with slightly different fallback strategies. |
| L-3 | Unused `PublicKey` import in `jupiter.ts` | Code hygiene. |
| L-4 | Unused direct deps in `shared/package.json` | `@metaplex-foundation/genesis` and `@noble/hashes` are not imported in shared source files. |
| L-5 | Hardcoded devnet explorer URL in UI | `transaction-approval.tsx:92-94` — won't work on mainnet. |
| L-6 | Keypair material in process memory indefinitely | The raw secret key string persists in the config singleton for the entire process lifetime. |
| L-7 | `Number()` precision loss for very large token amounts | `get-balance.ts`, `get-token-balances.ts` — safe for normal balances, but could produce incorrect results for extreme values. |
| L-8 | `get-transaction` only returns status, not full transaction details | System prompt says "Look up transaction details" but the tool only calls `getSignatureStatuses`. |
| L-9 | Debug traces array grows unbounded | `use-debug-panel.ts` — no cap on trace count. Long sessions could consume significant memory. |
| L-10 | Session timer in totals tab is static | Only updates on re-render, not live. |
| L-11 | Agent fee not disclosed in transaction approval UI | Users don't see the prepended fee in the UI; they must check the wallet popup. |
| L-12 | Timing-vulnerable token comparison | `websocket.ts:65` — uses `!==` instead of constant-time comparison. |
| L-13 | State file written without restricted permissions | `writeFileSync` uses default umask. |
| L-14 | Sleep tool enables resource exhaustion | Up to 300s * 10 steps = 50 minutes of blocking. |

---

## SPEC COMPLIANCE GAPS (4)

| # | Spec Claim | Status | Details |
|---|-----------|--------|---------|
| S-1 | `debug:generation_complete` includes "trace ID" | **PARTIAL** | The type has optional `traceId?` but the server never populates it. |
| S-2 | TypeScript "5.8+" in tech stack table | **STALE** | Root `package.json` has `^6.0.2`. Spec needs updating. |
| S-3 | LLM API key listed as "Required" | **PARTIAL** | Not validated in Zod schema — failure deferred to Mastra runtime with a less helpful error message. |
| S-4 | Appendix C File Map | **INCOMPLETE** | Missing: `layout.tsx`, `json-tree.tsx`, `.npmrc`, `.env.local.example`, `.gitignore` |

---

## ARCHITECTURE STRENGTHS

- **Clean dependency graph** — no circular dependencies, proper layering
- **Complete tool inventory** — all 14 tools present and correctly assigned by mode
- **Well-crafted system prompt** — covers all workflows, includes the bootstrap state-check optimization
- **Correct NoopSigner pattern** — public mode transaction construction is sound
- **TOKEN_OVERRIDE handling** — properly blocks `launch-token`, correctly resolved by `buyback-token` and `sell-token`
- **Proper React patterns** in the UI — ref-based callbacks avoid stale closures, effect cleanup is thorough, key props are correct everywhere
- **Comprehensive debug panel** — all 4 tabs, Cmd+D toggle, persisted state, token tracking
- **Reconnect logic** — exponential backoff 1s-10s with intentional close detection
- **Zod-validated config** — catches missing env vars at startup with formatted errors
