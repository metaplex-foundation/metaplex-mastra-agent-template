# NanoClaw WebSocket Protocol Specification

Version: 1.0
Last Updated: 2026-04-01

## Overview

NanoClaw exposes a WebSocket server on the web channel for real-time communication with web frontends. This document specifies the complete protocol for client-server communication, including authentication, message formats, and transaction signing flows.

## Connection

### Endpoint

```
ws://<host>:<port>/?token=<auth-token>
```

**Default Port**: `3002` (configurable via `WEB_CHANNEL_PORT` environment variable)

### Authentication

Two authentication methods are supported:

#### 1. Query Parameter (Recommended)
```
ws://localhost:3002/?token=f645b2d79859be93073cff5144d2b668728390559ae116bc
```

#### 2. Authorization Header
```javascript
const ws = new WebSocket('ws://localhost:3002/', {
  headers: {
    'Authorization': 'Bearer f645b2d79859be93073cff5144d2b668728390559ae116bc'
  }
});
```

### Authentication Failure

If authentication fails, the WebSocket connection is rejected with:
- **Close Code**: `4001`
- **Close Reason**: `"Unauthorized"`

### Connection Success

Upon successful connection, the server immediately sends a `connected` message:

```json
{
  "type": "connected",
  "jid": "web:default"
}
```

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
- The server stores the wallet address globally for this WebSocket server instance
- The server broadcasts a `wallet_connected` message to **all connected clients**
- Subsequent agent invocations will receive this wallet address automatically (no need to ask the user)

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
- The server clears the stored wallet address
- The server broadcasts a `wallet_disconnected` message to **all connected clients**

**Response:**
```json
{
  "type": "wallet_disconnected"
}
```

---

## Server → Client Messages

### 1. `connected` — Connection Acknowledged

Sent immediately after a successful WebSocket connection.

**Schema:**
```json
{
  "type": "connected",
  "jid": "web:default"
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Always `"connected"` |
| `jid` | `string` | The chat identifier. Always `"web:default"` for the web channel. |

**Delivery:**
- Sent **only** to the connecting client (not broadcast)
- Sent exactly once per connection

---

### 2. `message` — Agent Response

The agent's response to a user message.

**Schema:**
```json
{
  "type": "message",
  "content": "Here's how to launch a token on Solana...",
  "sender": "Claw"
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Always `"message"` |
| `content` | `string` | The agent's response text. May contain markdown formatting. |
| `sender` | `string` | The assistant's name (configured via `ASSISTANT_NAME` env var). |

**Delivery:**
- Broadcast to **all connected clients**
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
- Broadcast to **all connected clients**
- Sent at the start of agent processing (`isTyping: true`) and at completion (`isTyping: false`)

---

### 4. `transaction` — Transaction for Signing

A serialized Solana transaction that requires the user's wallet signature.

**Schema:**
```json
{
  "type": "transaction",
  "transaction": "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQAHELn...",
  "message": "Sign transaction 1 of 4 to launch Meatplex",
  "index": 0,
  "total": 4
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | Always `"transaction"` |
| `transaction` | `string` | Yes | Base64-encoded serialized Solana transaction |
| `message` | `string` | No | Human-readable description of what the transaction does |
| `index` | `number` | No | Zero-based index of this transaction in a multi-transaction sequence |
| `total` | `number` | No | Total number of transactions in the sequence |

**Delivery:**
- Broadcast to **all connected clients**
- Multiple transactions may be sent in rapid succession (e.g., token launch requires 4 transactions)

**Client Responsibilities:**
1. Decode the base64 `transaction` string to bytes
2. Deserialize using Solana's `Transaction.from()` or equivalent
3. Present transaction details to the user for review
4. Request signature from the user's wallet (e.g., Phantom, Solflare)
5. Submit the signed transaction to the Solana network
6. (Optional) Notify the agent of transaction status via a chat `message`

**Transaction Ordering:**
- When `index` and `total` are present, transactions should be presented in order
- The user should sign and submit transactions sequentially (index 0, then 1, then 2, etc.)
- If `index`/`total` are absent, treat as a single transaction

**Example Multi-Transaction Flow:**
```json
// Transaction 1/4
{ "type": "transaction", "transaction": "...", "message": "Sign transaction 1 of 4 to launch Meatplex", "index": 0, "total": 4 }

// Transaction 2/4
{ "type": "transaction", "transaction": "...", "message": "Sign transaction 2 of 4 to launch Meatplex", "index": 1, "total": 4 }

// Transaction 3/4
{ "type": "transaction", "transaction": "...", "message": "Sign transaction 3 of 4 to launch Meatplex", "index": 2, "total": 4 }

// Transaction 4/4
{ "type": "transaction", "transaction": "...", "message": "Sign transaction 4 of 4 to launch Meatplex", "index": 3, "total": 4 }
```

---

### 5. `wallet_connected` — Wallet Connection Confirmed

Broadcast after a client sends `wallet_connect`.

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
- Broadcast to **all connected clients** (including the one that sent `wallet_connect`)

---

### 6. `wallet_disconnected` — Wallet Disconnection Confirmed

Broadcast after a client sends `wallet_disconnect`.

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
- Broadcast to **all connected clients**

---

### 7. `error` — Error Response

Sent when the client sends an invalid message.

**Schema:**
```json
{
  "type": "error",
  "error": "Invalid JSON"
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Always `"error"` |
| `error` | `string` | Human-readable error message |

**Delivery:**
- Sent **only** to the client that caused the error (not broadcast)

**Common Error Messages:**

| Error | Cause |
|-------|-------|
| `"Invalid JSON"` | Message was not valid JSON |
| `"wallet_connect requires a non-empty address string"` | Missing or empty `address` in `wallet_connect` |
| `"Expected { type: \"message\", content: \"...\" }"` | Missing `content` field in `message` |
| `"Unknown message type: <type>"` | Unrecognized `type` field |

---

## Example Flow

### 1. Connect and Authenticate

```javascript
const ws = new WebSocket('ws://localhost:3002/?token=YOUR_TOKEN_HERE');

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
  "jid": "web:default"
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

**Server Response (broadcast to all clients):**
```json
{
  "type": "wallet_connected",
  "address": "BJjUoux3xacYcRZV31Ytsi4haJb3HgyzmweVDHutiLWU"
}
```

---

### 3. Send Message

```javascript
ws.send(JSON.stringify({
  type: 'message',
  content: 'Launch a memecoin called Meatplex with symbol $MEAT',
  sender_name: 'Alice'
}));
```

**Server Responses:**

1. Typing indicator starts:
```json
{
  "type": "typing",
  "isTyping": true
}
```

2. Agent response:
```json
{
  "type": "message",
  "content": "I'll help you launch Meatplex! I see your wallet is connected. Let me create the token launch...",
  "sender": "Claw"
}
```

3. Transactions for signing (4 total):
```json
{
  "type": "transaction",
  "transaction": "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQAHELn...",
  "message": "Sign transaction 1 of 4 to launch Meatplex",
  "index": 0,
  "total": 4
}
```
...3 more transactions follow...

4. Final response:
```json
{
  "type": "message",
  "content": "Transactions sent! Check your wallet and sign all 4 transactions.\n\n• Mint: 4rdwM8kCYKxsDf3hyqsmE4MMEsyT3bhbpXCVm71wPLEX\n• Genesis: 2YtBZYbBCPFPnm4tVohBY2hAGe3Sxid2gxYDch4KEByG",
  "sender": "Claw"
}
```

5. Typing indicator ends:
```json
{
  "type": "typing",
  "isTyping": false
}
```

---

### 4. Disconnect Wallet

```javascript
ws.send(JSON.stringify({
  type: 'wallet_disconnect'
}));
```

**Server Response (broadcast to all clients):**
```json
{
  "type": "wallet_disconnected"
}
```

---

## State Management

### Wallet State

- **Scope**: Global per WebSocket server instance (not per client)
- **Persistence**: In-memory only (lost on server restart)
- **Sharing**: All connected clients share the same wallet address

**Example:**
1. Client A connects and sends `wallet_connect` with address X
2. Client B connects later
3. Both clients see the same wallet address X
4. If Client B sends `wallet_disconnect`, both clients lose the wallet

### Connection State

- Each WebSocket connection is independent
- Disconnecting does not affect the wallet state (unless `wallet_disconnect` is sent)
- Multiple clients can be connected simultaneously and all receive broadcasts

---

## Implementation Notes

### For Frontend Developers

1. **Always send `wallet_connect` after connecting**
   The agent needs the wallet address to perform blockchain operations. Send it immediately after the `connected` message.

2. **Handle transactions asynchronously**
   Transactions arrive as separate messages. Buffer them if needed, especially in multi-transaction flows.

3. **Use `index` and `total` for UI ordering**
   When present, display transactions in order (index 0 first) with progress indicators ("Transaction 1 of 4").

4. **Subscribe to all message types**
   Your message handler should handle all server message types gracefully. Unknown types should be logged but not break the UI.

5. **Reconnection strategy**
   On disconnect, implement exponential backoff reconnection. Re-send `wallet_connect` after reconnecting if a wallet is still connected.

### For Backend Developers

1. **Broadcasting vs. Unicast**
   Most messages are broadcast to all clients. Only `connected` and `error` are unicast.

2. **Authentication is connection-level**
   Once authenticated, the client does not need to re-authenticate for individual messages.

3. **Wallet address validation**
   The server performs minimal validation (non-empty string). Validate Solana address format on the client side.

4. **Transaction encoding**
   Transactions are always base64-encoded. Do not send raw bytes.

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
    console.log('Transaction:', msg.index + 1, 'of', msg.total);
    console.log('Message:', msg.message);
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
   The `WEB_CHANNEL_TOKEN` is a shared secret. Treat it like a password. Do not commit it to version control.

2. **TLS/WSS**
   The protocol currently uses unencrypted WebSocket (`ws://`). For production, use WSS (`wss://`) behind a reverse proxy (nginx, Caddy) with TLS termination.

3. **Authentication**
   The current authentication is simple token-based. For production, consider implementing per-user authentication with session management.

4. **Transaction Verification**
   Always verify transaction contents on the client side before signing. The agent may make mistakes or be compromised.

5. **Rate Limiting**
   The server does not currently implement rate limiting. Consider adding it to prevent abuse.

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-04-01 | Initial specification with wallet support and transaction index/total fields |

---

## Support

For questions or issues:
- GitHub: https://github.com/anthropics/nanoclaw
- Documentation: /Users/kelliott/Metaplex/AI/nanoclaw/docs/

---

## License

This protocol specification is part of the NanoClaw project and follows the same license.
