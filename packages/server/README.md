# @metaplex-agent/server

The PlexChat WebSocket server for the Metaplex Agent Template. This package provides the real-time communication layer between web frontends and the Mastra agent, implementing the PlexChat protocol for chat messaging, wallet management, and transaction bridging.

## Overview

The server is a standalone WebSocket process built on the `ws` library. It:

- Authenticates incoming WebSocket connections with a shared token
- Routes chat messages to the Mastra agent and streams responses back
- Manages wallet state (connect/disconnect) and injects it into agent context
- Bridges transactions from agent tools to the frontend for wallet signing (public mode)
- Broadcasts typing indicators during agent processing

## Running the Server

### Development (with hot reload)

```bash
pnpm --filter @metaplex-agent/server dev
```

This uses `tsx watch` to auto-restart the server when source files change.

### Production

```bash
pnpm --filter @metaplex-agent/server build
pnpm --filter @metaplex-agent/server start
```

This compiles TypeScript to `dist/` and runs the compiled JavaScript with Node.

## Server Configuration

All configuration is read from environment variables (via the shared `getConfig()` function). The `.env` file at the workspace root is loaded automatically.

| Variable            | Type     | Default                              | Description                                        |
|---------------------|----------|--------------------------------------|----------------------------------------------------|
| `WEB_CHANNEL_PORT`  | `number` | `3002`                               | Port the WebSocket server listens on.              |
| `WEB_CHANNEL_TOKEN` | `string` | **(required)**                       | Shared secret for authenticating WebSocket clients. |
| `ASSISTANT_NAME`    | `string` | `Agent`                              | Name shown as the sender in agent chat responses.  |
| `AGENT_MODE`        | `string` | `public`                             | `public` or `autonomous`. Controls transaction flow.|
| `LLM_MODEL`        | `string` | `anthropic/claude-sonnet-4-5-20250929` | LLM provider and model in `provider/model` format.  |
| `SOLANA_RPC_URL`    | `string` | `https://api.devnet.solana.com`      | Solana RPC endpoint.                               |
| `AGENT_KEYPAIR`     | `string` | *(optional)*                         | Base58 secret key. Required only in autonomous mode.|

Generate a secure token with:

```bash
openssl rand -hex 24
```

## Protocol Message Summary

The full protocol specification is in [WEBSOCKET_PROTOCOL.md](../../WEBSOCKET_PROTOCOL.md) at the repository root. Below is a summary of all message types.

### Client to Server

| Type                | Direction        | Description                                                 |
|---------------------|------------------|-------------------------------------------------------------|
| `message`           | Client -> Server | Send a chat message to the agent. Fields: `content`, optional `sender_name`. |
| `wallet_connect`    | Client -> Server | Notify the server a Solana wallet is connected. Field: `address`. |
| `wallet_disconnect` | Client -> Server | Notify the server the wallet has been disconnected.         |

### Server to Client

| Type                  | Direction        | Delivery  | Description                                                       |
|-----------------------|------------------|-----------|-------------------------------------------------------------------|
| `connected`           | Server -> Client | Unicast   | Sent on successful connection. Contains `jid` identifier.         |
| `message`             | Server -> Client | Broadcast | Agent's chat response. Contains `content` and `sender` name.     |
| `typing`              | Server -> Client | Broadcast | Typing indicator. `isTyping: true` when processing starts, `false` when done. |
| `transaction`         | Server -> Client | Broadcast | Base64-encoded Solana transaction for wallet signing. Optional `message`, `index`, `total`. |
| `wallet_connected`    | Server -> Client | Broadcast | Confirms a wallet was connected. Contains `address`.              |
| `wallet_disconnected` | Server -> Client | Broadcast | Confirms the wallet was disconnected.                             |
| `error`               | Server -> Client | Unicast   | Error response for invalid client messages.                       |

## How the Transaction Bridge Works

In public mode, the agent cannot sign transactions itself. Instead, transactions are serialized and sent to the frontend for the user's wallet to sign. The server makes this possible by injecting a `TransactionSender` into the agent's `RequestContext`.

Here is the flow:

1. A chat message arrives. The server creates a `TransactionSender` that wraps the WebSocket `broadcast` method:

```typescript
const transactionSender: TransactionSender = {
  sendTransaction: (tx: ServerTransaction) => this.broadcast(tx),
};
```

2. The server builds a Mastra `RequestContext` populated with three values:

```typescript
const requestContext = new RequestContext<AgentContext>([
  ['walletAddress', this.walletAddress],
  ['transactionSender', transactionSender],
  ['agentMode', config.AGENT_MODE],
]);
```

3. The `RequestContext` is passed to `agent.generate()`. When a tool calls `submitOrSend()` in public mode, it uses the `transactionSender` to push the serialized transaction out over the WebSocket as a `transaction` message.

4. The frontend receives the `transaction` message, deserializes it, prompts the user to sign with their wallet (Phantom, Solflare, etc.), and submits it to the Solana network.

In autonomous mode, the `transactionSender` is still injected but never used. The `submitOrSend()` helper signs the transaction with the agent's keypair and submits it directly to the RPC.

## Authentication

The server supports two authentication methods, checked in order:

### 1. Query Parameter (recommended)

```
ws://localhost:3002/?token=YOUR_TOKEN_HERE
```

### 2. Authorization Header

```javascript
const ws = new WebSocket('ws://localhost:3002/', {
  headers: {
    'Authorization': 'Bearer YOUR_TOKEN_HERE'
  }
});
```

If the token does not match `WEB_CHANNEL_TOKEN`, the connection is immediately closed with code `4001` and reason `"Unauthorized"`.

Authentication is connection-level only. Once connected, individual messages do not require further authentication.

## Wallet State Management

Wallet state is managed as a **single global variable** on the `PlexChatServer` instance:

- **Scope**: Global per server process. All connected clients share the same wallet address.
- **Persistence**: In-memory only. The wallet address is lost on server restart.
- **Setting**: When any client sends `wallet_connect`, the address is stored and a `wallet_connected` message is broadcast to all clients.
- **Clearing**: When any client sends `wallet_disconnect`, the address is set to `null` and a `wallet_disconnected` message is broadcast to all clients.
- **Usage in agent**: If a wallet is connected, the server prepends `[User wallet: <address>]` to the chat message before sending it to the agent. The wallet address is also available to tools via the `RequestContext`.

This global model works well for the intended single-user or kiosk-style deployment. For multi-user scenarios, you would need to scope wallet state per connection or per session.

## File Structure

```
packages/server/
  src/
    index.ts       # Entry point -- instantiates and starts PlexChatServer
    websocket.ts   # PlexChatServer class with all protocol handling
  package.json
```
