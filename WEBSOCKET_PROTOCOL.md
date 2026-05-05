# PlexChat WebSocket Protocol Specification

Version: 2.0
Last Updated: 2026-05-04

## Overview

The Metaplex Agent Template exposes a WebSocket server implementing the **PlexChat** protocol for real-time bidirectional communication between frontends and the agent. This document specifies the complete protocol: authentication, message formats, the correlation-ID-based transaction signing flow, and per-session state model.

> **v2.0 changes vs v1.2:**
> - Authentication switched from `WEB_CHANNEL_TOKEN` shared-secret to a Sign-In-With-Solana (SIWS) handshake. The wallet that signs the SIWS challenge is bound to the session at auth time.
> - Legacy `?token=<auth-token>`, `Sec-WebSocket-Protocol: bearer, <token>`, and `Authorization: Bearer ...` are **no longer accepted**.
> - `wallet_connect` / `wallet_disconnect` (C2S) and `wallet_connected` / `wallet_disconnected` (S2C) are **removed** — the wallet is fixed by the SIWS handshake.
> - New tiered authorization via `AGENT_AUTH_MODE` (`owner` / `allowlist` / `open`).
> - New per-wallet sliding-window rate limit on **post-auth** chat-plane messages, complementing the existing per-session limiter.
> - New S2C messages: `auth_challenge`, `authenticated`, `auth_error`. New C2S message: `auth_response`.
>
> **v1.1 changes vs v1.0:** transactions now carry a server-assigned `correlationId`; `tx_result` requires `correlationId` + `signature`; new `tx_error` client message; all server -> client messages are unicast to the originating session (no cross-client broadcast); per-session wallet/conversation state.

## Connection

### Endpoint

```
ws://<host>:<port>/
```

**Default Port**: `3002` (configurable via `WEB_CHANNEL_PORT` environment variable)

The client opens a plain WebSocket connection — **no `?token=` query param, no `Sec-WebSocket-Protocol: bearer` subprotocol, no `Authorization: Bearer` header.** Any of those legacy auth methods are rejected; authentication is performed exclusively through the in-band SIWS handshake described below.

### Origin Validation

The server checks `Origin` against the `WS_ALLOWED_ORIGINS` env var (comma-separated, default `http://localhost:3001,http://localhost:3000`). Cross-site connections from disallowed origins are rejected during the handshake (CSWSH protection). Missing/undefined origins (curl, wscat) are allowed with a server-side warning.

### Authentication: Sign-In-With-Solana (SIWS)

Authentication is a four-step handshake driven by the server:

1. Client opens the WebSocket. Server sends `connected`, then immediately `auth_challenge` containing a single-use nonce.
2. Client constructs the canonical SIWS message, has the user's Solana wallet sign its UTF-8 bytes, and sends `auth_response` with the public key, signature, and signed message.
3. Server verifies the nonce, message, signature, and authorization tier. On success it consumes the nonce, binds the wallet to the session, and emits `authenticated`. From this point chat-plane traffic is accepted.
4. On any failure the server emits `auth_error` with a code and closes the WebSocket with code `4001`.

```
Client                              Server
  |                                   |
  |---- WebSocket open --------------->|
  |                                   | (origin validated)
  |                                   |
  |<--- {type: "connected", jid} -----|
  |<--- {type: "auth_challenge"} -----|
  |     (nonce, issuedAt, expiresAt)  |
  |                                   |
  | wallet.signMessage(canonical)     |
  |                                   |
  |---- {type: "auth_response"} ----->|
  |     (publicKey, signature, msg)   |
  |                                   | (verify nonce, signature, tier)
  |                                   |
  |<--- {type: "authenticated"} ------|
  |     (walletAddress, isOwner, sid) |
  |                                   |
  | (chat-plane traffic begins)       |
  |---- {type: "message", ...} ------>|
  |<--- {type: "message", ...} -------|
  |              ...                  |
```

The client has `AUTH_NONCE_TTL_MS` (default 60s) to respond. After expiry the server emits `auth_error` with `nonce_expired` and closes with `4001`. If the client sends nothing at all within `AUTH_HANDSHAKE_TIMEOUT_MS`, the server closes with `auth_timeout`.

#### Canonical SIWS Message

The client constructs **exactly** this UTF-8 string from the values in `auth_challenge` and signs its bytes with the user's wallet:

```
Sign in to {agentName}

Agent: {agentAsset || 'unregistered'}
Network: {network}
Nonce: {nonce}
Issued: {issuedAt}
Expires: {expiresAt}
```

The blank line after the greeting is intentional — wallets like Phantom and Solflare display this string verbatim in the signing prompt, and the formatting matters. Including `agentAsset` and `network` makes a signature non-replayable across agents and chains.

If the agent has not yet been registered on-chain, `agentAsset` is `null` in the challenge; the client substitutes the literal string `unregistered` in the canonical message.

#### Authorization Tiers

The server's `AGENT_AUTH_MODE` env var controls who is allowed to authenticate:

| Mode | Who passes |
|------|-----------|
| `owner` | Only the on-chain Agent Asset owner |
| `allowlist` | Wallets in `WALLET_ALLOWLIST` env or `wallets.allowlist.json`; the owner is always allowed |
| `open` | Any pubkey with a valid signature |

The current mode is reported in the `auth_challenge` so clients can inform the user before the wallet prompt appears.

#### Server Verification (fail-fast order)

1. Nonce exists in the server's nonce store and has not expired → else `nonce_invalid` / `nonce_expired`.
2. The `message` field in `auth_response` contains the issued nonce → else `message_mismatch`.
3. Ed25519 verification of `(message, signature, publicKey)` succeeds → else `signature_invalid`.
4. `publicKey` is allowed by the current authorization tier → else `not_authorized`.

On success the nonce is consumed (single-use; replay yields `nonce_invalid`), `walletAddress` is set on the session, and the session is promoted to `authenticated`.

#### Worked Example

A successful handshake against a registered agent named `Treasury Bot` running in `allowlist` mode on mainnet:

`auth_challenge` from server:

```json
{
  "type": "auth_challenge",
  "nonce": "9f4e7c1a2b8d6e5f3a0c1b2d3e4f5a6b",
  "issuedAt": "2026-05-04T19:00:00.000Z",
  "expiresAt": "2026-05-04T19:01:00.000Z",
  "agentName": "Treasury Bot",
  "agentAsset": "ARsZN4kZUWNX8Ek5ZkVUpRitSFjym6p9jLvUxrg9kPWU",
  "network": "solana-mainnet",
  "authMode": "allowlist"
}
```

Canonical message the client constructs and the wallet signs:

```
Sign in to Treasury Bot

Agent: ARsZN4kZUWNX8Ek5ZkVUpRitSFjym6p9jLvUxrg9kPWU
Network: solana-mainnet
Nonce: 9f4e7c1a2b8d6e5f3a0c1b2d3e4f5a6b
Issued: 2026-05-04T19:00:00.000Z
Expires: 2026-05-04T19:01:00.000Z
```

`auth_response` from client:

```json
{
  "type": "auth_response",
  "publicKey": "DwLLgBwG3eVNqHnp9CPsRKL2dVePVdXJq1tvNHCMC2YS",
  "signature": "5x9k7Qa3vZ4f8nP2tR1mLcXyB6sH9wJ0eU8oFqA1bN3kM2pT4hV5zC6dY7xS8gW9aR0iE1uO2pK3lQ4nM5jH6tF7Qa",
  "message": "Sign in to Treasury Bot\n\nAgent: ARsZN4kZUWNX8Ek5ZkVUpRitSFjym6p9jLvUxrg9kPWU\nNetwork: solana-mainnet\nNonce: 9f4e7c1a2b8d6e5f3a0c1b2d3e4f5a6b\nIssued: 2026-05-04T19:00:00.000Z\nExpires: 2026-05-04T19:01:00.000Z"
}
```

`signature` is a base58-encoded 64-byte Ed25519 signature. `message` MUST be the exact UTF-8 string the wallet signed — the server re-checks that the issued nonce appears inside it.

`authenticated` from server:

```json
{
  "type": "authenticated",
  "walletAddress": "DwLLgBwG3eVNqHnp9CPsRKL2dVePVdXJq1tvNHCMC2YS",
  "isOwner": true,
  "sessionId": "8f3b1c2a-4d5e-4b10-9a3f-2c7e8d1a5b60"
}
```

Once `authenticated` is received, the chat-plane (`message`, `tx_result`, `tx_error`) opens.

### Connection Success

Upon successful WebSocket connection (before authentication completes), the server immediately sends a `connected` message:

```json
{
  "type": "connected",
  "jid": "web:8f3b1c2a-4d5e-4b10-9a3f-2c7e8d1a5b60"
}
```

The `jid` is a per-session identifier of the form `web:<uuid>`, unique per WebSocket connection. It is **not** a shared or stable chat-room name — a second client connecting to the same server receives its own distinct `jid`, and reconnecting produces a new `jid`.

`connected` is sent only to the connecting client (not broadcast). Receiving `connected` does **not** mean the session is authenticated; the client must still complete the SIWS handshake before any chat-plane message will be accepted.

### Authentication Failure (close code 4001)

If authentication fails for any reason, the server emits an `auth_error` and then closes the WebSocket with:

- **Close Code**: `4001`
- **Close Reason**: the `code` field of the `auth_error`, which is one of:

| Code | Meaning |
|------|---------|
| `nonce_expired` | The issued nonce's TTL elapsed before the client responded |
| `nonce_invalid` | The presented nonce is not in the server's store (replay, wrong nonce, or already consumed) |
| `message_mismatch` | The signed `message` doesn't include the issued nonce, or the `auth_response` payload was malformed JSON |
| `signature_invalid` | Ed25519 verification of `(message, signature, publicKey)` failed |
| `not_authorized` | The wallet is valid but not allowed by the current `AGENT_AUTH_MODE` tier |
| `auth_timeout` | The client did not send `auth_response` within `AUTH_HANDSHAKE_TIMEOUT_MS` |

The client hook **must** treat `4001` as terminal and **must NOT** auto-reconnect — doing so burns nonces and never recovers the session. Surface the failure reason to the user instead and require an explicit retry.

**Note:** Once a session is authenticated, exceeding the per-wallet sliding-window rate limit (60 chat messages / 60 seconds by default; see `WALLET_RATE_LIMIT_*`) yields a regular `error` message with `code: "RATE_LIMIT"` — not an `auth_error`, and the socket stays open.

---

## Message Format

All messages are JSON objects with a `type` field that determines the message schema.

### Encoding
- All messages must be valid UTF-8 JSON
- The client must parse incoming messages as JSON
- Invalid JSON from the client triggers an `error` message (post-auth) or `auth_error` (during the handshake)

### Client → Server message summary

| `type` | Allowed before auth? | Purpose |
|--------|---------------------|---------|
| `auth_response` | Yes (required) | Completes the SIWS handshake |
| `message` | No | Send a chat message to the agent |
| `tx_result` | No | Report a successful signed/submitted transaction |
| `tx_error` | No | Report a rejected or failed transaction |

Any chat-plane message sent before `authenticated` is rejected.

### Server → Client message summary

| `type` | When sent |
|--------|-----------|
| `connected` | Once, immediately on socket open |
| `auth_challenge` | Once, immediately after `connected` |
| `authenticated` | Once, on successful SIWS verification |
| `auth_error` | On any auth failure; followed by `ws.close(4001, code)` |
| `message` | Each agent reply (may stream multiple times per turn) |
| `typing` | At the start and end of agent processing |
| `transaction` | Whenever a tool needs the user's signature |
| `error` | On invalid post-auth client messages |

---

## Client → Server Messages

### 1. `auth_response` — Complete SIWS handshake

Sent in reply to `auth_challenge`. See **Authentication: Sign-In-With-Solana (SIWS)** above for the full handshake.

**Schema:**
```json
{
  "type": "auth_response",
  "publicKey": "DwLLgBwG3eVNqHnp9CPsRKL2dVePVdXJq1tvNHCMC2YS",
  "signature": "5x9...7Qa",
  "message": "Sign in to Treasury Bot\n\nAgent: ..."
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | Must be `"auth_response"` |
| `publicKey` | `string` | Yes | Base58-encoded Solana public key of the signing wallet |
| `signature` | `string` | Yes | Base58-encoded 64-byte Ed25519 signature over `message` |
| `message` | `string` | Yes | The exact UTF-8 canonical SIWS message that was signed (must contain the issued nonce) |

**Behavior:**
- Sent exactly once per connection, in response to `auth_challenge`.
- On success, the server replies with `authenticated` and binds the wallet to the session.
- On failure, the server replies with `auth_error` and closes with code `4001`.

**Error Conditions:**
- See the auth-error code table above.

---

### 2. `message` — Send Chat Message

Send a text message to the agent. Only accepted after `authenticated`.

**Schema:**
```json
{
  "type": "message",
  "content": "Hello, can you help me launch a token?",
  "sender_name": "Alice"
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | Must be `"message"` |
| `content` | `string` | Yes | Message text. Must be non-empty after trimming. |
| `sender_name` | `string` | No | Display name of the sender. Defaults to `"Web User"`. |

**Behavior:**
- Empty content (after trimming whitespace) is ignored
- The message is stored in the database and triggers agent processing if conditions are met
- The server does not send an acknowledgment — responses come asynchronously as `message` from the agent

**Error Conditions:**
- Missing `content` → `error` message: `"Expected { type: \"message\", content: \"...\" }"`
- Empty `content` → silently ignored

---

### 3. `tx_result` — Report Signed Transaction

Sent by the client after the user successfully signs a transaction in their wallet and the client submits it to the Solana network.

**Schema:**
```json
{
  "type": "tx_result",
  "correlationId": "6f3b9b96-6b30-4b1d-9b92-8e7c3f0e1a2f",
  "signature": "5eAnVpQyRm...pZGvP3QSuT"
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | Must be `"tx_result"` |
| `correlationId` | `string` | Yes | Echoes the `correlationId` from the server's `transaction` message this tx_result is responding to. |
| `signature` | `string` | Yes | Base58-encoded transaction signature returned by the Solana RPC. |

**Behavior:**
- Server looks up the pending transaction entry for this session keyed by `correlationId`.
- On match, resolves the tool's awaiting `Promise<string>` with the signature and clears the pending entry's timeout.
- On no match (unknown / already-resolved / wrong session), the server replies with an `error` message and drops the `tx_result` — the correlationId is not forgeable across sessions.
- In autonomous mode, `tx_result` is rejected with an `error` (autonomous agents sign and submit themselves; there are no pending user transactions).

**Error Conditions:**
- Missing `correlationId` or `signature` → `error` message with a descriptive string.
- Unknown `correlationId` → `error` message: `"Unknown correlationId"` (silently dropped server-side to avoid corrupting another session's state).

---

### 4. `tx_error` — Report Failed / Rejected Transaction

Sent by the client when the user rejects the signing prompt, the wallet throws an error, or the Solana RPC rejects the submitted transaction.

**Schema:**
```json
{
  "type": "tx_error",
  "correlationId": "6f3b9b96-6b30-4b1d-9b92-8e7c3f0e1a2f",
  "reason": "User rejected the request"
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | Must be `"tx_error"` |
| `correlationId` | `string` | Yes | Echoes the `correlationId` from the server's `transaction` message. |
| `reason` | `string` | No | Short human-readable description of the failure. Sanitized server-side (bracket, newline, length limits) before being surfaced to the LLM. |

**Behavior:**
- Server looks up the pending entry for this session keyed by `correlationId`.
- On match, rejects the tool's awaiting `Promise<string>` with an `Error` whose message contains the sanitized reason. Clears the timeout. The LLM sees a tool failure and can retry or report to the user.
- On no match, server replies with an `error` message and drops.
- Multi-transaction flows should clear any queued unsigned transactions client-side when a `tx_error` is emitted — the server does not assume continuation.

**Error Conditions:**
- Missing `correlationId` → `error` message.
- `reason` that fails sanitization is replaced with a generic `"Transaction failed"` before reaching the LLM.

---

## Server → Client Messages

All server-to-client messages are **unicast** to the originating session. There is no cross-session broadcast.

### 1. `connected` — Connection Acknowledged

Sent immediately after a successful WebSocket connection.

**Schema:**
```json
{
  "type": "connected",
  "jid": "web:8f3b1c2a-4d5e-4b10-9a3f-2c7e8d1a5b60"
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Always `"connected"` |
| `jid` | `string` | Per-session identifier of the form `web:<uuid>`. Unique per WebSocket connection; changes on reconnect. |

**Delivery:**
- Sent only to the connecting client
- Sent exactly once per connection, before `auth_challenge`

---

### 2. `auth_challenge` — SIWS Challenge

Sent immediately after `connected`. See **Authentication: Sign-In-With-Solana (SIWS)** for the full handshake.

**Schema:**
```json
{
  "type": "auth_challenge",
  "nonce": "9f4e7c1a2b8d6e5f3a0c1b2d3e4f5a6b",
  "issuedAt": "2026-05-04T19:00:00.000Z",
  "expiresAt": "2026-05-04T19:01:00.000Z",
  "agentName": "Treasury Bot",
  "agentAsset": "ARsZN4kZUWNX8Ek5ZkVUpRitSFjym6p9jLvUxrg9kPWU",
  "network": "solana-mainnet",
  "authMode": "allowlist"
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Always `"auth_challenge"` |
| `nonce` | `string` | Single-use random nonce the client must include in the signed message |
| `issuedAt` | `string` | ISO-8601 timestamp when the challenge was issued |
| `expiresAt` | `string` | ISO-8601 timestamp when the nonce expires (`AUTH_NONCE_TTL_MS` after `issuedAt`) |
| `agentName` | `string` | Human-readable agent name shown in the signing prompt |
| `agentAsset` | `string \| null` | Base58 Agent Asset address, or `null` if the agent is unregistered |
| `network` | `string` | Network label (e.g. `solana-mainnet`, `solana-devnet`) |
| `authMode` | `"owner" \| "allowlist" \| "open"` | The current authorization tier |

**Delivery:**
- Sent exactly once per connection, immediately after `connected`
- Unicast

---

### 3. `authenticated` — Authentication Succeeded

Sent after the server verifies the client's `auth_response`. From this point chat-plane traffic is accepted.

**Schema:**
```json
{
  "type": "authenticated",
  "walletAddress": "DwLLgBwG3eVNqHnp9CPsRKL2dVePVdXJq1tvNHCMC2YS",
  "isOwner": true,
  "sessionId": "8f3b1c2a-4d5e-4b10-9a3f-2c7e8d1a5b60"
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Always `"authenticated"` |
| `walletAddress` | `string` | Base58 Solana public key bound to this session |
| `isOwner` | `boolean` | `true` iff `walletAddress` matches the on-chain Agent Asset owner |
| `sessionId` | `string` | Stable session identifier (UUID) for the duration of this connection |

**Delivery:**
- Sent exactly once per connection, on successful authentication
- Unicast

---

### 4. `auth_error` — Authentication Failed

Sent when the SIWS handshake fails for any reason. Always followed by `ws.close(4001, code)`.

**Schema:**
```json
{
  "type": "auth_error",
  "code": "signature_invalid",
  "message": "Signature failed Ed25519 verification."
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Always `"auth_error"` |
| `code` | `string` | One of: `nonce_expired`, `nonce_invalid`, `message_mismatch`, `signature_invalid`, `not_authorized`, `auth_timeout` |
| `message` | `string` | Human-readable explanation, safe to surface to the user |

**Delivery:**
- Unicast, then the socket is closed with code `4001`
- Clients MUST NOT auto-reconnect

---

### 5. `message` — Agent Response

The agent's response to a user message.

**Schema:**
```json
{
  "type": "message",
  "content": "Here's how to launch a token on Solana...",
  "sender": "Agent"
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Always `"message"` |
| `content` | `string` | The agent's response text. May contain markdown formatting. |
| `sender` | `string` | The assistant's name (configured via `ASSISTANT_NAME` env var). |

**Delivery:**
- Unicast to the session that sent the originating `message` (not broadcast to other sessions)
- May arrive multiple times per user message (streaming responses)

---

### 6. `typing` — Typing Indicator

Indicates whether the agent is currently processing a message.

**Schema:**
```json
{
  "type": "typing",
  "isTyping": true
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Always `"typing"` |
| `isTyping` | `boolean` | `true` when the agent starts processing, `false` when done. |

**Delivery:**
- Unicast
- Sent at the start of agent processing (`isTyping: true`) and at completion (`isTyping: false`)

---

### 7. `transaction` — Transaction for Signing

A serialized Solana transaction that requires the user's wallet signature. The server always attaches a `correlationId`; the client **must** echo it in the corresponding `tx_result` or `tx_error`.

**Schema:**
```json
{
  "type": "transaction",
  "transaction": "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQAHELn...",
  "correlationId": "6f3b9b96-6b30-4b1d-9b92-8e7c3f0e1a2f",
  "feeSol": 0.001,
  "message": "Transfer 0.5 SOL to Alice",
  "index": 0,
  "total": 1
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | Always `"transaction"` |
| `transaction` | `string` | Yes | Base64-encoded serialized Solana transaction |
| `correlationId` | `string` | Yes | Server-assigned unique ID. Must be echoed in `tx_result` / `tx_error`. |
| `feeSol` | `number` | No | SOL fee prepended to the transaction (public mode, only once the agent is registered). Lets the UI display a human-readable fee. |
| `message` | `string` | No | Human-readable description of what the transaction does |
| `index` | `number` | No | Zero-based index of this transaction in a multi-transaction sequence |
| `total` | `number` | No | Total number of transactions in the sequence |

**Delivery:**
- Unicast to the session that initiated the agent turn
- Multiple transactions may be sent in rapid succession for multi-tx tools; each carries its own `correlationId`

**Client Responsibilities:**
1. Decode the base64 `transaction` string to bytes
2. Deserialize using Solana's `VersionedTransaction.deserialize()` (or `Transaction.from()` for legacy)
3. Present the transaction to the user (include `message` and `feeSol` when present)
4. Request signature from the user's wallet (Phantom, Solflare, ...)
5. Submit the signed transaction to the Solana network
6. **On success:** send `{ "type": "tx_result", "correlationId": "<same>", "signature": "<base58>" }`
7. **On rejection / failure:** send `{ "type": "tx_error", "correlationId": "<same>", "reason": "<string>" }`

If the client fails to send either `tx_result` or `tx_error`, the server's pending promise is rejected after a **5-minute timeout** and the tool surfaces this as a timeout error to the LLM.

**Transaction Ordering:**
- When `index` and `total` are present, transactions should be presented in order
- The user should sign and submit transactions sequentially (index 0, then 1, then 2, etc.)
- If one tx in a multi-tx flow fails, the client should clear any queued subsequent txs — the server does not continue the flow from a partial state

> **Note on `launch-token`:** Although the spec previously implied token launch sends 4 user-signed txs, the template's current `launch-token` is **agent-signed**: it uses the Metaplex Genesis SDK and signs with the agent keypair, not the user wallet. `index`/`total` remain available for other future multi-tx tools.

**Example Multi-Transaction Flow (generic):**
```json
// Transaction 1/2
{ "type": "transaction", "transaction": "...", "correlationId": "abc-1", "message": "Sign transaction 1 of 2", "index": 0, "total": 2 }

// Client responds with tx_result for correlationId "abc-1"...

// Transaction 2/2
{ "type": "transaction", "transaction": "...", "correlationId": "abc-2", "message": "Sign transaction 2 of 2", "index": 1, "total": 2 }
```

---

### 8. `error` — Error Response

Sent when the client sends an invalid post-auth message. Authentication-phase failures use `auth_error` instead.

**Schema:**
```json
{
  "type": "error",
  "error": "Invalid JSON",
  "code": "INVALID_JSON"
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Always `"error"` |
| `error` | `string` | Human-readable error message |
| `code` | `string` | Optional machine-readable error code |

**Delivery:**
- Unicast to the session that caused the error

**Common Error Messages:**

| Error | Cause |
|-------|-------|
| `"Invalid JSON"` | Message was not valid JSON |
| `"Expected { type: \"message\", content: \"...\" }"` | Missing `content` field in `message` |
| `"tx_result requires correlationId and signature"` | Missing field in `tx_result` |
| `"tx_error requires correlationId"` | Missing field in `tx_error` |
| `"Unknown correlationId"` | `tx_result` / `tx_error` referenced an unknown or already-resolved correlationId |
| `"Unknown message type: <type>"` | Unrecognized `type` field (length-capped server-side) |
| `"Not authenticated"` | Chat-plane message sent before SIWS handshake completed |

---

## Example Flow

### 1. Connect and Authenticate (SIWS)

```javascript
import bs58 from 'bs58';

// Plain WebSocket — no auth tokens in URL or headers.
const ws = new WebSocket('ws://localhost:3002/');

ws.onmessage = async (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === 'connected') {
    console.log('Socket open:', msg.jid);
    return; // wait for auth_challenge
  }

  if (msg.type === 'auth_challenge') {
    const canonical = [
      `Sign in to ${msg.agentName}`,
      ``,
      `Agent: ${msg.agentAsset ?? 'unregistered'}`,
      `Network: ${msg.network}`,
      `Nonce: ${msg.nonce}`,
      `Issued: ${msg.issuedAt}`,
      `Expires: ${msg.expiresAt}`,
    ].join('\n');

    const messageBytes = new TextEncoder().encode(canonical);
    const { signature } = await wallet.signMessage(messageBytes); // wallet adapter

    ws.send(JSON.stringify({
      type: 'auth_response',
      publicKey: wallet.publicKey.toBase58(),
      signature: bs58.encode(signature),
      message: canonical,
    }));
    return;
  }

  if (msg.type === 'authenticated') {
    console.log('Authenticated as', msg.walletAddress, 'isOwner=', msg.isOwner);
    // Chat-plane traffic is now allowed.
    return;
  }

  if (msg.type === 'auth_error') {
    console.error('Auth failed:', msg.code, msg.message);
    // Do NOT reconnect on close 4001. Show the error to the user.
    return;
  }
};

ws.onclose = (event) => {
  if (event.code === 4001) {
    // Terminal — do not auto-reconnect.
    return;
  }
  // Other codes can use exponential backoff + new SIWS handshake.
};
```

---

### 2. Send Message with a Transaction Round-Trip

Once `authenticated` is received, the client can send chat-plane messages:

```javascript
ws.send(JSON.stringify({
  type: 'message',
  content: 'Send 0.5 SOL to 7xKXt...',
  sender_name: 'Alice'
}));
```

**Server responses (interleaved):**

1. Typing indicator starts:
```json
{ "type": "typing", "isTyping": true }
```

2. Agent narration:
```json
{
  "type": "message",
  "content": "Sure! I'll prepare a transfer of 0.5 SOL. Please approve it in your wallet.",
  "sender": "Agent"
}
```

3. Transaction for signing — note the `correlationId`:
```json
{
  "type": "transaction",
  "transaction": "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQAHELn...",
  "correlationId": "6f3b9b96-6b30-4b1d-9b92-8e7c3f0e1a2f",
  "feeSol": 0.001,
  "message": "Transfer 0.5 SOL to 7xKXt...",
  "index": 0,
  "total": 1
}
```

4. Client signs in wallet, submits to Solana, then sends back the signature:
```javascript
ws.send(JSON.stringify({
  type: 'tx_result',
  correlationId: '6f3b9b96-6b30-4b1d-9b92-8e7c3f0e1a2f',
  signature: '5eAnVpQyRm...pZGvP3QSuT'
}));
```

5. Server resolves the tool's pending promise; agent continues and confirms to the user:
```json
{
  "type": "message",
  "content": "Transfer sent. Signature: 5eAnVpQyRm...pZGvP3QSuT",
  "sender": "Agent"
}
```

6. Typing indicator ends:
```json
{ "type": "typing", "isTyping": false }
```

**On rejection** — if the user rejects the signing prompt, the client sends `tx_error` instead of `tx_result`:

```javascript
ws.send(JSON.stringify({
  type: 'tx_error',
  correlationId: '6f3b9b96-6b30-4b1d-9b92-8e7c3f0e1a2f',
  reason: 'User rejected the request'
}));
```

The server rejects the tool's pending promise with an `Error("User rejected the request")`. The LLM sees a tool failure and can inform the user or retry.

---

## State Management

### Session Model

Each WebSocket connection gets its own `Session` object with isolated state. The server does **not** share wallet, conversation, or transaction state across clients. See `docs/SPEC.md` §10.7 for the design rationale.

### Wallet State

- **Scope**: Per-session (per WebSocket connection)
- **Source of truth**: The wallet that signed the SIWS challenge during the handshake. The wallet is fixed at auth time and cannot be changed mid-session.
- **Persistence**: In-memory only (lost when the session disconnects or the server restarts)
- **Sharing**: No — two sessions connected to the same server instance each have their own `walletAddress`, even if both are signed in with the same key

To switch wallets, the client must close the WebSocket and re-authenticate with a new SIWS handshake.

### Conversation State

- **Scope**: Per-session (conversation history is not shared across connections)
- **Persistence**: In-memory only (lost on disconnect / restart)

### Pending Transactions

- Each session maintains its own `Map<correlationId, pendingPromise>`
- On disconnect, all pending promises are rejected with `"client disconnected"` and cleared

### Connection State

- Each WebSocket connection is fully independent
- The server caps concurrent sessions at `MAX_CONNECTIONS` (default 10)
- Per-session `aliveCheck` ping/pong keeps stale connections from leaking

---

## Implementation Notes

### For Frontend Developers

1. **Complete the SIWS handshake before sending anything else**
   The wallet that signs the `auth_challenge` is the wallet bound to the session. There is no separate `wallet_connect` step. Only emit chat-plane messages (`message`, `tx_result`, `tx_error`) after `authenticated`.

2. **Do not auto-reconnect on close code `4001`**
   `4001` is terminal. Auto-reconnecting burns nonces and never recovers. Surface the `auth_error.code` to the user and require an explicit retry.

3. **Construct the canonical SIWS message exactly**
   Including the blank line after the greeting. Wallets render the string verbatim — any difference between what the wallet shows and what the server expects fails verification.

4. **Always echo `correlationId` in `tx_result` / `tx_error`**
   The server matches the client's response to the originating tool call by `correlationId`. Never invent your own; always use the exact value from the server's `transaction` message.

5. **Always send exactly one of `tx_result` or `tx_error` per `transaction`**
   Silently failing to respond leaves the tool's promise pending until the 5-minute timeout. On wallet reject → `tx_error`. On submit failure → `tx_error` with the error message as `reason`. On success → `tx_result` with the signature.

6. **Abort multi-tx queues on `tx_error`**
   If tx N in an `index/total` flow fails, clear any queued unsigned txs client-side. The server does not auto-continue a partial multi-tx flow.

7. **Buffer outgoing messages during reconnect**
   `send()` during a temporary disconnect should queue the message locally and flush on reconnect (after a fresh SIWS handshake) — otherwise `message`, `tx_result`, and `tx_error` can be silently dropped.

8. **Subscribe to all message types**
   Your message handler should handle all server message types gracefully. Unknown types should be logged but not break the UI.

9. **Reconnection strategy**
   On non-4001 disconnect, implement exponential backoff reconnection. Each reconnect requires a new SIWS handshake — the server does not remember your wallet across reconnects (per-session state is lost on disconnect).

### For Backend Developers

1. **All server → client messages are unicast**
   There is no cross-session broadcast. A session only ever sees its own agent responses, transactions, and debug events.

2. **Authentication is the single SIWS handshake**
   Once `authenticated` has been emitted, the client does not re-authenticate for individual messages. The wallet is bound to the session for its lifetime.

3. **Wallet address is server-derived**
   The server derives `walletAddress` from the verified SIWS signature. Clients cannot override or claim a different wallet post-handshake.

4. **Transaction encoding**
   Transactions are always base64-encoded. Do not send raw bytes.

5. **correlationId generation is server-side**
   The client must never generate a correlationId. The server creates one (UUID) when emitting each `transaction` and verifies inbound `tx_result`/`tx_error` against the per-session map.

---

## Testing

### Using wscat

Install wscat:
```bash
npm install -g wscat
```

Connect (no auth token in the URL):
```bash
wscat -c 'ws://localhost:3002/'
```

`wscat` is awkward for SIWS because the user must paste a base58 Ed25519 signature in response to `auth_challenge`. For real testing, use the SDK example below or a Solana wallet adapter in a browser. For a quick smoke test you can sign the canonical message offline with `solana-keygen` + a small Node script and paste the resulting `auth_response` JSON into wscat.

### Example Node Test Client

```javascript
const WebSocket = require('ws');
const nacl = require('tweetnacl');
const bs58 = require('bs58');

// secretKey: 64-byte Uint8Array (Solana keypair)
const secretKey = bs58.decode(process.env.TEST_WALLET_SECRET_BASE58);
const keyPair = nacl.sign.keyPair.fromSecretKey(secretKey);
const publicKey = bs58.encode(keyPair.publicKey);

const ws = new WebSocket('ws://localhost:3002/');

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  console.log('Received:', msg.type);

  if (msg.type === 'auth_challenge') {
    const canonical = [
      `Sign in to ${msg.agentName}`,
      ``,
      `Agent: ${msg.agentAsset ?? 'unregistered'}`,
      `Network: ${msg.network}`,
      `Nonce: ${msg.nonce}`,
      `Issued: ${msg.issuedAt}`,
      `Expires: ${msg.expiresAt}`,
    ].join('\n');

    const sig = nacl.sign.detached(Buffer.from(canonical, 'utf8'), keyPair.secretKey);

    ws.send(JSON.stringify({
      type: 'auth_response',
      publicKey,
      signature: bs58.encode(sig),
      message: canonical,
    }));
    return;
  }

  if (msg.type === 'authenticated') {
    console.log('Authenticated as', msg.walletAddress);
    ws.send(JSON.stringify({
      type: 'message',
      content: 'Launch a memecoin called TestCoin',
      sender_name: 'Tester',
    }));
    return;
  }

  if (msg.type === 'auth_error') {
    console.error('Auth failed:', msg.code, msg.message);
    return;
  }

  if (msg.type === 'transaction') {
    console.log('Transaction:', (msg.index ?? 0) + 1, 'of', msg.total ?? 1);
    console.log('correlationId:', msg.correlationId);
    console.log('feeSol:', msg.feeSol);
    console.log('Message:', msg.message);
    // ...sign and submit tx here, then echo correlationId back...
    // On success:
    //   ws.send(JSON.stringify({ type: 'tx_result', correlationId: msg.correlationId, signature }));
    // On reject/error:
    //   ws.send(JSON.stringify({ type: 'tx_error',  correlationId: msg.correlationId, reason }));
  }
});

ws.on('close', (code, reason) => {
  console.log('Closed:', code, reason.toString());
});
```

> **Smoke-test footnote:** when testing `owner` mode by hand, note that the agent's `AGENT_KEYPAIR` is the executive signer for on-chain operations, **not** the asset owner. To pass owner-tier authorization, the connecting client needs the secret key of the wallet that owns the on-chain Agent Asset (`AGENT_ASSET_ADDRESS`). In typical autonomous-mode deployments that is the operator's personal wallet, not the keypair stored on the agent host.

---

## Security Considerations

1. **No shared secrets**
   v2.0 removes `WEB_CHANNEL_TOKEN`. The agent no longer holds a long-lived token that, if leaked, would grant chat access. Authentication binds each session to a wallet via a single-use SIWS signature.

2. **TLS/WSS**
   The protocol uses unencrypted WebSocket (`ws://`) by default. For production, terminate TLS at a reverse proxy (nginx, Caddy) and serve via `wss://`. SIWS does not encrypt traffic — it only authenticates the session's identity.

3. **Authorization Tiers**
   `AGENT_AUTH_MODE` controls who can authenticate. Default to `owner` for autonomous-mode deployments managed by a single operator. Use `allowlist` (paired with `WALLET_ALLOWLIST` or `wallets.allowlist.json`) for small trusted groups. `open` is for public-facing agents and accepts any valid signature; in that mode all per-wallet protections (rate limiting, on-chain reputation) become more important.

4. **Origin Validation**
   The server rejects handshakes with an `Origin` outside `WS_ALLOWED_ORIGINS`. Keep this list tight in production — it is your CSWSH defense.

5. **Nonce Replay Protection**
   Nonces are single-use and TTL-bounded (`AUTH_NONCE_TTL_MS`, default 60s). Stolen `auth_response` payloads cannot be reused after the original session consumes the nonce, and stale signatures fail verification once the TTL elapses.

6. **Per-Wallet Rate Limiting**
   Once a wallet has authenticated, the server enforces a sliding-window rate limit on chat-plane messages (default 60 / 60 s, configurable via `WALLET_RATE_LIMIT_*`). The cap aggregates across all of that wallet's concurrent sessions, so a single wallet opening multiple WebSockets cannot multiply its budget. The owner is exempt. Excess messages yield `{type: "error", code: "RATE_LIMIT"}` and the socket stays open.

7. **Transaction Verification**
   Always verify transaction contents on the client side before signing. The agent may make mistakes or be compromised.

8. **Edge Rate Limiting**
   The server applies per-session rate limits internally. In production, also put an application-layer gateway (Cloudflare, reverse proxy) in front to cap handshake attempts by IP at the edge.

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-04-01 | Initial specification with wallet support and transaction `index`/`total` fields |
| 1.1 | 2026-04-16 | Added `correlationId` on `transaction`; added `tx_result`/`tx_error` client messages with required `correlationId`; changed all server → client delivery to unicast; per-session wallet/conversation state; added `feeSol` on `transaction`; awaitable `submitOrSend` model |
| 1.2 | 2026-04-17 | Added subprotocol auth (`Sec-WebSocket-Protocol: bearer, <token>`); clarified `jid` is per-session (`web:<uuid>`, not `web:default`); documented `Origin` validation via `WS_ALLOWED_ORIGINS`; raised `WEB_CHANNEL_TOKEN` minimum to 32 chars; documented terminal behavior of close code `4001` |
| 2.0 | 2026-05-04 | Replaced shared-secret auth with SIWS handshake; removed `?token=`, `Sec-WebSocket-Protocol: bearer`, and `Authorization: Bearer`; removed `wallet_connect`/`wallet_disconnect` C2S and `wallet_connected`/`wallet_disconnected` S2C; added `auth_challenge`, `authenticated`, `auth_error` S2C and `auth_response` C2S; introduced `AGENT_AUTH_MODE` tiers and per-wallet rate limiting |

---

## Support

For questions or issues:
- Repository: the Metaplex Agent Template repo that ships this file
- Documentation: see `docs/SPEC.md` for the canonical product spec

---

## License

This protocol specification is part of the Metaplex Agent Template and follows the same license.
