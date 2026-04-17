# Metaplex Agent Template — Review Report

**Date:** 2026-04-16
**Reviewed against:** `docs/SPEC.md` v1.0
**Reviewers:** 4 parallel subagents (spec compliance, security, WebSocket/protocol, frontend/UX), consolidated

---

## TL;DR

The happy path works and closely matches the spec: tool inventory, identity model, fee prepending, bootstrap sequence, and auth policy are implemented correctly. But there are **four critical issues that compromise the product** and several major UX/spec gaps worth fixing before broader use:

1. Live secrets in `packages/ui/.env.local` are not gitignored.
2. Shared server state makes public multi-user mode unsafe (`walletAddress`, `conversationHistory`, `isProcessing`, `isOwnerVerified`, all `debug:*` broadcasts are per-server, not per-connection).
3. `tx_result` and `tx_error` are unauthenticated prompt-injection channels.
4. Abort + stream cleanup can hang `isProcessing` forever because the abort signal is never passed to `agent.stream`.

Everything else is fixable without architectural change.

---

## Critical

### C1. `packages/ui/.env.local` contains live secrets and is not gitignored
- `.gitignore` covers `.env` but not `.env.local`.
- The file contains a real Helius API key and `NEXT_PUBLIC_WS_TOKEN`.
- A `git add .` leaks credentials.
- **Fix:** add `**/.env.local` to `.gitignore`, rotate the Helius key and `WEB_CHANNEL_TOKEN`.

### C2. Shared server state breaks public multi-user mode (§3.1, §12.6) and autonomous gate (§3.2)
- `PlexChatServer` stores `walletAddress`, `conversationHistory`, `isProcessing`, `isOwnerVerified`, `pendingTxResults`, `pendingMessages`, `currentAbortController` as single fields (`packages/server/src/websocket.ts:42-57`).
- `broadcast()` sends agent text, transactions, typing indicators, and every `debug:*` event to every connected client (`:476`, `:389-447`, `:579-593`).
- **Exploit (public):** Client A asks "what's in my wallet?" → agent responds to A with balance → Client B (different wallet, same shared token) receives A's wallet address, holdings, signatures, and streaming reasoning. B can `wallet_connect` to overwrite A's session so the agent builds transactions sourced from B; the tx is broadcast to A who could mis-approve it.
- **Exploit (autonomous):** Once any owner has verified via `wallet_connect`, `isOwnerVerified=true` is sticky. A non-owner who connects afterward and sends `message` without `wallet_connect` passes the gate at `:233-241` — direct violation of §3.2.
- **Fix:** Move all session state onto a per-`WebSocket` record. Unicast all agent output, transactions, and debug events.

### C3. `tx_result` / `tx_error` are prompt-injection and state-forgery channels
- `handleTxResult` injects `[System: The user approved and signed a transaction. Confirmed signature: <sig>. Continue…]` into conversation history (`websocket.ts:282`). No correlation to an outstanding transaction; no on-chain verification. Any client can fake "the user signed" mid-flow.
- `handleTxError` interpolates a completely unsanitized `error` string into `[System: …: <ATTACKER_STRING>. Inform the user…]` (`:300`). An attacker can close the bracket and inject a fake `[System: …]` directive the LLM can't distinguish from real server directives.
- **Fix:** (a) Track pending transactions keyed by a server-assigned `correlationId` (field already declared but unused); only accept `tx_result`/`tx_error` for known IDs. (b) Sanitize the error string (strip `[`, `]`, newlines; cap length). (c) In autonomous mode reject `tx_result` entirely. (d) Stop prefixing untrusted text with `[System: …]`; use `[User-reported: …]` or a tool-result channel.

### C4. Abort + stream cleanup can hang `isProcessing` forever
- `currentAbortController.abort()` is called on last-client-disconnect (`websocket.ts:144`) but the signal is never passed into `agent.stream(...)` (`:366`). Aborting the controller only short-circuits the reader loop; `await stream.text` / `await stream.totalUsage` afterward can wait indefinitely.
- If that hangs, `isProcessing` stays `true` → server rejects all future messages.
- **Fix:** pass `abortSignal: this.currentAbortController.signal` to `agent.stream`; call `reader.cancel()` before awaiting `stream.text`.

---

## High

### H1. UI never reports transaction rejection/failure to server
- `sendTxError` exists in `packages/ui/src/hooks/use-plexchat.ts:263` but is never imported or called. On wallet reject / sign failure, `transaction-approval.tsx` sets local state to `error` but the server keeps `isProcessing=true` and the agent waits forever.
- Multi-tx flows desync — queue advances to tx 3 while the server thinks tx 2 succeeded.
- **Fix:** call `sendTxError` from `page.tsx` on reject/error branch; clear `txQueue` on abort.

### H2. Slippage max is 10000 bps (100%) with no price-impact check
- `swap-token.ts:22`, `buyback-token.ts:24`, `sell-token.ts:24` accept `slippageBps.max(10000)`.
- A prompt-injected LLM can drain the treasury to a dust token.
- **Fix:** cap at 500 bps default (configurable via `MAX_SLIPPAGE_BPS`); reject quotes where `priceImpactPct` exceeds a threshold.

### H3. Agent blindly signs Jupiter-returned transaction with no integrity check
- `packages/shared/src/jupiter.ts:110-113` deserializes `swapTransaction` and signs with `umi.identity` without verifying the tx matches requested mints/amount/destination.
- **Fix:** decode the versioned tx before signing; assert `inputMint` debit ≤ requested amount, `outputMint` appears as destination, only `umi.identity` is a required signer.

### H4. Owner cache poisons on RPC failure
- `packages/shared/src/auth.ts:111-118` stores `{owner: null}` when `fetchAsset` throws.
- A transient RPC blip during startup locks an autonomous agent permanently; only a process restart recovers.
- **Fix:** don't cache failures; only cache successful fetches. Optional: short TTL on successful entries so on-chain ownership changes propagate.

### H5. `submitOrSend` doesn't actually await `tx_result` (§6.6 step 8 not implemented)
- `packages/shared/src/transaction.ts:71-79` fires the tx over WS and returns `'sent-to-wallet'` immediately. The tool returns `{status:'pending'}`. When `tx_result` later arrives, the server starts a new agent turn with a synthetic system message — the signature is not correlated with the tool call.
- Agent can't directly use the signature; multi-step flows depend on prompt engineering.
- **Fix:** correlation-ID-keyed promise map; tool awaits and returns the signature as its actual tool-result.

### H6. `launch-token` never uses `submitOrSend` or `index/total`
- Spec §6.6 explicitly calls out "token launch = 4 txs" with sequential `index/total`.
- `packages/core/src/tools/shared/launch-token.ts:83-102` signs everything with the agent keypair, bypassing public-mode user signing.
- `correlationId` / `index` / `total` are declared in the protocol but never populated anywhere.
- **Fix:** decompose into discrete public-mode txs routed through `submitOrSend` with indexing, OR update spec to say launch is agent-signed by design.

---

## Medium

### Spec & config
- **M1.** `MAX_STEPS`, `ENABLE_DEBUG_EVENTS`, `MAX_CONNECTIONS` are in `packages/shared/src/config.ts:36-41` but missing from spec §8.1 and `.env.example`.
- **M2.** `tx_error` client message type exists in code (`packages/shared/src/types/protocol.ts:33-38`, `websocket.ts:260`) but is absent from spec §6.3 / Appendix A.
- **M3.** `AGENT_KEYPAIR` is only validated as `.min(1)` — typos fail cryptically at first use. Add base58/JSON + 64-byte length refinement.
- **M4.** LLM API key is never checked at startup. Wrong provider string or missing key passes config validation; first message blows up inside Mastra.
- **M5.** `AGENT_ASSET_ADDRESS`, `AGENT_TOKEN_MINT`, `TOKEN_OVERRIDE` pass `z.string()` with no base58 regex.
- **M6.** README "Project Structure" (lines 183-232) and "Adding New Tools" example (281-343) are stale — flat tool layout, missing `prompts.ts`, wrong `AgentContext` shape. README env-var table (158-171) incorrectly marks `AGENT_KEYPAIR` as autonomous-only.

### Protocol & server
- **M7.** `ping` heartbeat and per-client `aliveCheck` intervals are never cleared on server teardown — no `stop()` / SIGTERM handling in `packages/server/src/index.ts`.
- **M8.** `debug:context` isn't re-emitted on error or disconnect → stale `connectedClients` count in debug panel.
- **M9.** `handleChatMessage` drains `pendingMessages` with `if` instead of `while` — depends on async-recursion to catch up.
- **M10.** Rate limit (20/10s per client) is per-connection only; no token-budget or tool-execution ceiling.

### Frontend UX
- **M11.** No preflight of RPC or keypair at startup. Bad RPC URL surfaces as "I encountered an error" many agent turns later.
- **M12.** Transaction approval modal shows only `transaction.message` (optional) — no decoded instructions, no fee total, no destination summary.
- **M13.** Outgoing `sendMessage` / `sendTxResult` are silently dropped when WS is mid-reconnect (`use-plexchat.ts:222-243`). User's message appears in local chat but never reaches the agent.
- **M14.** Multi-tx modal: rejecting tx N advances to tx N+1 instead of aborting the whole flow — orphaned partial on-chain state.
- **M15.** User-supplied `content` is interpolated into the `[Agent: … | User wallet: …]` prefix with no bracket-escape. Sanitize or move status to a real `system` role turn.

### Tool errors
- **M16.** Every tool's `catch` stringifies `error.message` into the returned `message` and feeds it into the LLM — can surface internal RPC URLs, addresses, amounts. Return structured error codes instead.

---

## Low / polish

- **L1.** `BASE58_RE` is one regex used for both addresses and signatures. Split into `BASE58_ADDRESS_RE` (32-44) and `BASE58_SIGNATURE_RE` (64-88).
- **L2.** Tools don't validate `destination`/`mint` as base58 via Zod — relies on `publicKey()` to throw.
- **L3.** `packages/shared/src/state.ts` walks up from `cwd` with no repo-boundary stop.
- **L4.** `chat-message.tsx` uses `react-markdown` without `rehype-sanitize` or a custom `a` renderer — `javascript:` links render clickable.
- **L5.** Typing indicator isn't cleared during streaming (`text_delta` doesn't set `isAgentTyping=false`).
- **L6.** Typing indicator doesn't clear on WS close — stuck forever after a drop.
- **L7.** Debug panel `activeTab` doesn't persist; `generation_complete` isn't emitted on the error path so traces stay perpetually "pending".
- **L8.** `withAuth` uses shallow spread — may lose non-enumerable Mastra metadata.
- **L9.** `WEB_CHANNEL_TOKEN` / `AGENT_KEYPAIR` should warn below a min-length threshold.
- **L10.** `.env.example` lacks `# REQUIRED` / `# OPTIONAL` markers and blank entries for `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`.
- **L11.** `Unknown message type: <raw>` echoes attacker-controlled type — cap length + strip non-printable.
- **L12.** 0.02 SOL funding amount and 0.01 threshold are hardcoded in `register-agent.ts:72, 61`.
- **L13.** Spec §5.3 default auth policy example lacks the `ownerWallet !== null` guard that the code (correctly) has.

---

## Positive findings (verified)

- All 12 shared + 2 public tools are present with correct `auth` levels; mode assignment gives 14/12 as specified.
- Unified identity (keypair + asset + PDA + token) is genuinely shared across modes.
- `secureTokenCompare` uses `timingSafeEqual` with length precheck.
- `AGENT_KEYPAIR` is never logged; config fails fast with Zod.
- Fee prepend is atomic, bounded (`0 ≤ fee ≤ 1 SOL`), and recipient is PDA-derived. Correctly skipped pre-registration.
- `resolveOwner` correctly prefers on-chain → `OWNER_WALLET` → null.
- `register-agent` clears the owner cache on successful registration.
- State file is written atomically (tmp + rename) with `0o600`.

---

## Remediation priority

| Priority | Work |
|---|---|
| 1 | C1 — rotate secrets, fix `.gitignore` |
| 2 | C2 — per-session state |
| 3 | C3 — correlation-ID + sanitization for tx_result/tx_error |
| 4 | C4 + H1 — abort wiring + send tx_error from UI |
| 5 | H2 + H3 — slippage cap + Jupiter tx verification |
| 6 | H4 — cache only successes |
| 7 | H5 + H6 — real tx correlation + launch-token multi-tx |
| 8 | M1–M6 — docs/spec drift |
| 9 | M7–M16 + L-series — polish |
