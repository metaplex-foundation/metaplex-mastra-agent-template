# Audit Fixes Design Plan

**Date:** 2026-04-16
**Scope:** Fix all Critical, High, and Medium findings from AUDIT_REPORT.md. Address select Low findings where the fix is trivial.

---

## Workstream 1: Server Hardening (websocket.ts)

Addresses: C-1, C-2, H-3, H-4, H-5, H-6, H-7, H-8, H-9, M-5, M-11, M-12, M-13, M-14, M-15, L-12

### 1.1 Rate limiting and connection limits
- Add `maxPayload: 64 * 1024` (64KB) to WebSocketServer options
- Add `MAX_CONNECTIONS` constant (default 10) — reject new connections when exceeded
- Add per-connection rate limiter: max 20 messages per 10 seconds (simple sliding window)
- Cap `conversationHistory` at 50 messages (sliding window, keep system messages)

### 1.2 Input validation
- Validate wallet addresses: regex `/^[1-9A-HJ-NP-Za-km-z]{32,44}$/` before storing
- Validate tx_result signatures: same base58 regex, length 64-88
- Constant-time token comparison via `crypto.timingSafeEqual`
- Origin validation: add optional `ALLOWED_ORIGINS` env var, check in `verifyClient`

### 1.3 Transaction lifecycle overhaul
- Replace `pendingTxResult: string | null` with `pendingTxResults: string[]` (queue)
- Add `pendingTxContext: Map<string, string>` mapping correlation IDs to context messages
- Add `correlationId` field to `ServerTransaction` type
- Make `handleTxResult` use a generic system message with the signature, not hardcoded "funding"
- Process all queued results in the finally block

### 1.4 Message serialization
- Add a message queue: `pendingMessages: Array<{ws, content, senderName, isSystem}>`
- When `isProcessing` is true, queue incoming chat messages
- Drain the queue in the finally block after the current generation completes

### 1.5 Connection health
- Add `ws.on('error')` handler per client
- Add `wss.on('error')` handler on the server
- Add ping/pong heartbeat every 30 seconds, terminate stale connections after 60s
- Track an `AbortController` per generation — if all clients disconnect, abort the stream

### 1.6 Debug event gating
- Add `ENABLE_DEBUG_EVENTS` env var (default `true` for template, documented as `false` for production)
- Skip all `debug:*` broadcasts when disabled

### 1.7 Configuration additions to config.ts
- Add `AGENT_FEE_SOL` bounds: `.min(0).max(1)`
- Add `MAX_STEPS` env var: `z.coerce.number().default(10).min(1).max(50)`
- Add `ENABLE_DEBUG_EVENTS` env var: `z.coerce.boolean().default(true)`
- Add `MAX_CONNECTIONS` env var: `z.coerce.number().default(10)`

---

## Workstream 2: Protocol Type Updates (protocol.ts)

Addresses: M-6, H-4

### 2.1 Add ClientTransactionError
```typescript
export interface ClientTransactionError {
  type: 'tx_error';
  error: string;
  index?: number;
}
```

### 2.2 Add correlationId to ServerTransaction
Add optional `correlationId?: string` field

### 2.3 Add ClientTransactionError to ClientMessage union

---

## Workstream 3: Shared Package Fixes

Addresses: H-10, M-1, M-3, M-4, L-3

### 3.1 jupiter.ts — fix blockhash confirmation
- Use the `lastValidBlockHeight` from the `SwapResponse` instead of fetching a new blockhash
- Get the blockhash from the deserialized transaction
- Remove unused `PublicKey` import

### 3.2 state.ts — atomic writes
- Write to a temp file first, then rename (atomic on POSIX)
- Set file permissions to 0o600

### 3.3 config.ts — validate state overlay
- Validate state values with base58 regex before merging into config

---

## Workstream 4: Core Tool Fixes

Addresses: H-1, H-2, M-1, M-2, M-16

### 4.1 get-token-price.ts — fix Jupiter Price API response shape
- Response is `{ data: { [mint]: { id, type, price } } }` where `price` is a string
- Parse correctly: `data.data[mintAddress]?.price`

### 4.2 delegate-execution.ts — fix phantom bs58 dependency
- Replace `import bs58 from 'bs58'` with `import { base58 } from '@metaplex-foundation/umi/serializers'`
- Update signature encoding to use `base58.deserialize(result.signature)[0]`

### 4.3 launch-token.ts — add missing updateConfigFromState()
- Add `import { updateConfigFromState } from '@metaplex-agent/shared'`
- Call `updateConfigFromState()` after `setState()`

### 4.4 Read-only tools — add try/catch error handling
- Wrap `get-balance`, `get-token-balances`, `get-transaction` execute bodies in try/catch
- Return structured error objects the LLM can interpret

### 4.5 Transfer tool descriptions — remove autonomous mode reference
- Update descriptions to only reference public mode

---

## Workstream 5: UI Fixes

Addresses: M-8, M-9, M-10, L-5

### 5.1 transaction-approval.tsx
- Use `Promise.race` with 60-second timeout for `confirmTransaction`
- Store the auto-close `setTimeout` in a ref and clear it on unmount
- Derive explorer cluster from `NEXT_PUBLIC_SOLANA_RPC_URL`

### 5.2 page.tsx — transaction queue
- Replace `pendingTx: ServerTransaction | null` with `txQueue: ServerTransaction[]`
- Show the first item, remove it on completion, show the next

### 5.3 use-plexchat.ts — add tx_error support
- Add `sendTxError` method that sends `{ type: 'tx_error', error: string }`
- Call it when user rejects a transaction in the approval modal

---

## Implementation Order

All 5 workstreams can be executed in parallel since they touch different files. The only dependency is that Workstream 2 (protocol types) should complete before Workstream 1 (server) and Workstream 5 (UI) reference the new types, but since we're in a monorepo with TypeScript, we can edit all files simultaneously and build at the end.
