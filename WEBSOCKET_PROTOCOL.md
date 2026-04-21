# PlexChat WebSocket Protocol Specification

Version: 1.2
Last Updated: 2026-04-17

## Overview

The Metaplex Agent Template exposes a WebSocket server implementing the **PlexChat** protocol for real-time bidirectional communication between frontends and the agent. This document specifies the complete protocol: authentication, message formats, the correlation-ID-based transaction signing flow, and per-session state model.

> **v1.1 changes vs v1.0:** transactions now carry a server-assigned `correlationId`; `tx_result` requires `correlationId` + `signature`; new `tx_error` client message; all server -> client messages are unicast to the originating session (no cross-client broadcast); per-session wallet/conversation state.

## Connection

### Endpoint

```
ws://<host>:<port>/
```

**Default Port**: `3002` (configurable via `WEB_CHANNEL_PORT` environment variable)

The token is supplied via one of the three methods in the **Authentication** section below. The query-param form (`?token=<auth-token>`) remains supported for convenience but is not recommended for production use.

### Authentication

Three authentication methods are supported. The server accepts any of them; clients should pick one.

`WEB_CHANNEL_TOKEN` must be at least **32 characters**. Generate with `openssl rand -hex 24` (48 hex chars) or `openssl rand -hex 32` (64 hex chars).

#### 1. Subprotocol (Recommended for production)

The client sends the token as the second WebSocket subprotocol:

```javascript
const ws = new WebSocket('ws://localhost:3002/', ['bearer', token]);
```

On the wire this sends `Sec-WebSocket-Protocol: bearer, <token>`. The server validates the second subprotocol entry and, on accept, echoes `bearer` back as the negotiated subprotocol. Unlike the query param, the token does not appear in URL access logs, browser history, or Referer headers.

Server-side validation is constant-time (`timingSafeEqual`).

#### 2. Authorization Header

```javascript
const ws = new WebSocket('ws://localhost:3002/', {
  headers: {
    'Authorization': 'Bearer f645b2d79859be93073cff5144d2b668728390559ae116bc'
  }
});
```

Useful for non-browser WS clients that can set custom headers (Node `ws`, `wscat` with `-H`). Browsers cannot set this header when constructing a `WebSocket`, so prefer the subprotocol form for browser clients.

#### 3. Query Parameter (Convenience for local dev / CLI)

```
ws://localhost:3002/?token=f645b2d79859be93073cff5144d2b668728390559ae116bc
```

Supported for ad-hoc tools like `wscat`. Discouraged in production because the token leaks through reverse-proxy logs, browser history, and Referer headers.

### Authentication Failure

If authentication fails, the WebSocket connection is rejected with:
- **Close Code**: `4001`
- **Close Reason**: `"Unauthorized"`

The client hook **must** treat `4001` as terminal and stop reconnecting (retrying with the same bad token is pointless).

### Origin Validation

The server checks `Origin` against the `WS_ALLOWED_ORIGINS` env var (comma-separated, default `http://localhost:3001,http://localhost:3000`). Cross-site connections from disallowed origins are rejected during the handshake (CSWSH protection). Missing/undefined origins (curl, wscat) are allowed with a server-side warning.

### Connection Success

Upon successful connection, the server immediately sends a `connected` message:

```json
{
  "type": "connected",
  "jid": "web:8f3b1c2a-4d5e-4b10-9a3f-2c7e8d1a5b60"
}
```

The `jid` is a per-session identifier of the form `web:<uuid>`, unique per WebSocket connection. It is **not** a shared or stable chat-room name -- a second client connecting to the same server receives its own distinct `jid`, and reconnecting produces a new `jid`.

This message is sent only to the connecting client (not broadcast).

---

## Message Format

All messages are JSON objects with a `type` field that determines the message schema.

### Encoding
- All messages must be valid UTF-8 JSON
- The client must parse incoming messages as JSON
- Invalid JSON from the client triggers an `error` message

---

## Client → Server Messages

### 1. `message` — Send Chat Message

Send a text message to the agent.

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

### 2. `wallet_connect` — Connect Solana Wallet

Notify the server that the user has connected a Solana wallet.

**Schema:**
```json
{
  "type": "wallet_connect",
  "address": "BJjUoux3xacYcRZV31Ytsi4haJb3HgyzmweVDHutiLWU"
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | Must be `"wallet_connect"` |
| `address` | `string` | Yes | Solana public key (base58-encoded). Must be non-empty. |

**Behavior:**
- The server stores the wallet address **on this session only** (per-connection, not global)
- The server replies to the connecting client with a `wallet_connected` message (unicast; no broadcast to other sessions)
- In autonomous mode, this triggers owner verification — the session is flagged `isOwnerVerified=true` only if the address matches the resolved owner (on-chain asset owner, or `BOOTSTRAP_WALLET` fallback)
- Subsequent agent invocations on this session receive this wallet address automatically

**Response:**
```json
{
  "type": "wallet_connected",
  "address": "BJjUoux3xacYcRZV31Ytsi4haJb3HgyzmweVDHutiLWU"
}
```

**Error Conditions:**
- Missing `address` → `error` message: `"wallet_connect requires a non-empty address string"`
- Empty `address` → `error` message: `"wallet_connect requires a non-empty address string"`

---

### 3. `wallet_disconnect` — Disconnect Wallet

Notify the server that the user has disconnected their wallet.

**Schema:**
```json
{
  "type": "wallet_disconnect"
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | Must be `"wallet_disconnect"` |

**Behavior:**
- The server clears the wallet address on **this session only** (other sessions are unaffected)
- The server replies with a `wallet_disconnected` message (unicast)
- In autonomous mode, this also clears `isOwnerVerified` on the session

**Response:**
```json
{
  "type": "wallet_disconnected"
}
```

---

### 4. `tx_result` — Report Signed Transaction

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

### 5. `tx_error` — Report Failed / Rejected Transaction

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
- Sent exactly once per connection

---

### 2. `message` — Agent Response

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

### 3. `typing` — Typing Indicator

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

### 4. `transaction` — Transaction for Signing

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

### 5. `wallet_connected` — Wallet Connection Confirmed

Sent after the session receives a `wallet_connect`.

**Schema:**
```json
{
  "type": "wallet_connected",
  "address": "BJjUoux3xacYcRZV31Ytsi4haJb3HgyzmweVDHutiLWU"
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Always `"wallet_connected"` |
| `address` | `string` | The Solana wallet address that was connected |

**Delivery:**
- Unicast to the originating session only

---

### 6. `wallet_disconnected` — Wallet Disconnection Confirmed

Sent after the session receives a `wallet_disconnect`.

**Schema:**
```json
{
  "type": "wallet_disconnected"
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Always `"wallet_disconnected"` |

**Delivery:**
- Unicast to the originating session only

---

### 7. `error` — Error Response

Sent when the client sends an invalid message.

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
| `"wallet_connect requires a non-empty address string"` | Missing or empty `address` in `wallet_connect` |
| `"Expected { type: \"message\", content: \"...\" }"` | Missing `content` field in `message` |
| `"tx_result requires correlationId and signature"` | Missing field in `tx_result` |
| `"tx_error requires correlationId"` | Missing field in `tx_error` |
| `"Unknown correlationId"` | `tx_result` / `tx_error` referenced an unknown or already-resolved correlationId |
| `"Unknown message type: <type>"` | Unrecognized `type` field (length-capped server-side) |

---

## Example Flow

### 1. Connect and Authenticate

```javascript
// Recommended for browsers: subprotocol auth (token not in URL).
const ws = new WebSocket('ws://localhost:3002/', ['bearer', YOUR_TOKEN_HERE]);

// Equivalent legacy form (token in URL; works but leaks via logs/history/Referer):
// const ws = new WebSocket('ws://localhost:3002/?token=YOUR_TOKEN_HERE');

ws.onopen = () => {
  console.log('WebSocket connected');
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log('Received:', msg);

  if (msg.type === 'connected') {
    console.log('Connected to chat:', msg.jid);
  }
};
```

**Server Response:**
```json
{
  "type": "connected",
  "jid": "web:8f3b1c2a-4d5e-4b10-9a3f-2c7e8d1a5b60"
}
```

---

### 2. Connect Wallet

```javascript
ws.send(JSON.stringify({
  type: 'wallet_connect',
  address: 'BJjUoux3xacYcRZV31Ytsi4haJb3HgyzmweVDHutiLWU'
}));
```

**Server Response (unicast to this session):**
```json
{
  "type": "wallet_connected",
  "address": "BJjUoux3xacYcRZV31Ytsi4haJb3HgyzmweVDHutiLWU"
}
```

---

### 3. Send Message with a Transaction Round-Trip

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

### 4. Disconnect Wallet

```javascript
ws.send(JSON.stringify({
  type: 'wallet_disconnect'
}));
```

**Server Response (unicast):**
```json
{
  "type": "wallet_disconnected"
}
```

---

## State Management

### Session Model

Each WebSocket connection gets its own `Session` object with isolated state. The server does **not** share wallet, conversation, or transaction state across clients. See `docs/SPEC.md` §10.7 for the design rationale.

### Wallet State

- **Scope**: Per-session (per WebSocket connection)
- **Persistence**: In-memory only (lost when the session disconnects or the server restarts)
- **Sharing**: No — two sessions connected to the same server instance each have their own `walletAddress`

**Example:**
1. Client A connects and sends `wallet_connect` with address X → session A has walletAddress=X
2. Client B connects later and sends `wallet_connect` with address Y → session B has walletAddress=Y
3. If Client B sends `wallet_disconnect`, only session B clears its wallet — session A is unaffected

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

1. **Always send `wallet_connect` after connecting**
   The agent needs the wallet address to perform blockchain operations. Send it immediately after the `connected` message.

2. **Always echo `correlationId` in `tx_result` / `tx_error`**
   The server matches the client's response to the originating tool call by `correlationId`. Never invent your own; always use the exact value from the server's `transaction` message.

3. **Always send exactly one of `tx_result` or `tx_error` per `transaction`**
   Silently failing to respond leaves the tool's promise pending until the 5-minute timeout. On wallet reject → `tx_error`. On submit failure → `tx_error` with the error message as `reason`. On success → `tx_result` with the signature.

4. **Abort multi-tx queues on `tx_error`**
   If tx N in an `index/total` flow fails, clear any queued unsigned txs client-side. The server does not auto-continue a partial multi-tx flow.

5. **Buffer outgoing messages during reconnect**
   `send()` during a temporary disconnect should queue the message locally and flush on reconnect — otherwise `message`, `tx_result`, and `tx_error` can be silently dropped.

6. **Subscribe to all message types**
   Your message handler should handle all server message types gracefully. Unknown types should be logged but not break the UI.

7. **Reconnection strategy**
   On disconnect, implement exponential backoff reconnection. Re-send `wallet_connect` after reconnecting — the server does not remember your wallet across reconnects (per-session state is lost on disconnect).

### For Backend Developers

1. **All server → client messages are unicast**
   There is no cross-session broadcast. A session only ever sees its own agent responses, transactions, and debug events.

2. **Authentication is connection-level**
   Once authenticated, the client does not need to re-authenticate for individual messages.

3. **Wallet address validation**
   The server performs minimal validation (non-empty string). Validate Solana address format on the client side.

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

Connect:
```bash
wscat -c 'ws://localhost:3002/?token=YOUR_TOKEN_HERE'
```

Test wallet connection:
```json
{"type":"wallet_connect","address":"BJjUoux3xacYcRZV31Ytsi4haJb3HgyzmweVDHutiLWU"}
```

Send a message:
```json
{"type":"message","content":"Hello!","sender_name":"Test User"}
```

Disconnect wallet:
```json
{"type":"wallet_disconnect"}
```

### Example JavaScript Test Client

```javascript
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3002/?token=YOUR_TOKEN_HERE');

ws.on('open', () => {
  console.log('Connected');

  // Connect wallet
  ws.send(JSON.stringify({
    type: 'wallet_connect',
    address: 'BJjUoux3xacYcRZV31Ytsi4haJb3HgyzmweVDHutiLWU'
  }));

  // Send message
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: 'message',
      content: 'Launch a memecoin called TestCoin',
      sender_name: 'Tester'
    }));
  }, 1000);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  console.log('Received:', msg.type);

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

ws.on('error', (err) => {
  console.error('Error:', err);
});

ws.on('close', (code, reason) => {
  console.log('Closed:', code, reason.toString());
});
```

---

## Security Considerations

1. **Token Protection**
   The `WEB_CHANNEL_TOKEN` is a shared secret. Treat it like a password. Do not commit it to version control. Minimum length is 32 characters.

2. **TLS/WSS**
   The protocol currently uses unencrypted WebSocket (`ws://`). For production, use WSS (`wss://`) behind a reverse proxy (nginx, Caddy) with TLS termination.

3. **Authentication**
   The current authentication is simple token-based. Prefer the subprotocol or Authorization-header form over the query param in production (the query param leaks through logs, browser history, and Referer). For multi-user deployments, consider per-user JWTs or session cookies tied to your application's auth system.

4. **Origin Validation**
   The server rejects handshakes with an `Origin` outside `WS_ALLOWED_ORIGINS`. Keep this list tight in production -- it is your CSWSH defense.

5. **Transaction Verification**
   Always verify transaction contents on the client side before signing. The agent may make mistakes or be compromised.

6. **Rate Limiting**
   The server applies per-session rate limits internally. In production, put an application-layer gateway (Cloudflare, reverse proxy) in front to also cap handshake attempts by IP.

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-04-01 | Initial specification with wallet support and transaction `index`/`total` fields |
| 1.1 | 2026-04-16 | Added `correlationId` on `transaction`; added `tx_result`/`tx_error` client messages with required `correlationId`; changed all server → client delivery to unicast; per-session wallet/conversation state; added `feeSol` on `transaction`; awaitable `submitOrSend` model |
| 1.2 | 2026-04-17 | Added subprotocol auth (`Sec-WebSocket-Protocol: bearer, <token>`); clarified `jid` is per-session (`web:<uuid>`, not `web:default`); documented `Origin` validation via `WS_ALLOWED_ORIGINS`; raised `WEB_CHANNEL_TOKEN` minimum to 32 chars; documented terminal behavior of close code `4001` |

---

## Support

For questions or issues:
- Repository: the Metaplex Agent Template repo that ships this file
- Documentation: see `docs/SPEC.md` for the canonical product spec

---

## License

This protocol specification is part of the Metaplex Agent Template and follows the same license.
