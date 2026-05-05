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
| `AGENT_AUTH_MODE`   | `string` | auto-resolved                        | `owner` / `allowlist` / `open`. See [Authentication](#authentication). |
| `WALLET_ALLOWLIST`  | `string` | *(empty)*                            | Comma-separated base58 pubkeys; merged with `wallets.allowlist.json`. |
| `ASSISTANT_NAME`    | `string` | `Agent`                              | Name shown as the sender in agent chat responses.  |
| `AGENT_MODE`        | `string` | `public`                             | `public` or `autonomous`. Controls transaction flow.|
| `LLM_MODEL`        | `string` | `anthropic/claude-sonnet-4-5-20250929` | LLM provider and model in `provider/model` format.  |
| `SOLANA_RPC_URL`    | `string` | `https://api.devnet.solana.com`      | Solana RPC endpoint.                               |
| `AGENT_KEYPAIR`     | `string` | **(required)**                       | Base58 secret key or JSON byte array. Required in both modes. |

The full env contract lives in [`.env.example`](../../.env.example) and [`docs/SPEC.md`](../../docs/SPEC.md) §8.1.

## Protocol Message Summary

The full protocol specification is in [WEBSOCKET_PROTOCOL.md](../../WEBSOCKET_PROTOCOL.md) at the repository root. Below is a summary of all message types.

### Client to Server

| Type                | Direction        | Description                                                 |
|---------------------|------------------|-------------------------------------------------------------|
| `auth_response`     | Client -> Server | SIWS handshake response. Fields: `publicKey`, `signature`, `message`. |
| `message`           | Client -> Server | Send a chat message to the agent. Fields: `content`, optional `sender_name`. |
| `tx_result`         | Client -> Server | Report a signed transaction. Fields: `correlationId`, `signature`. |
| `tx_error`          | Client -> Server | Report a failed/rejected transaction. Fields: `correlationId`, `reason`. |

### Server to Client

All server → client messages are unicast to the originating session.

| Type             | Direction        | Description                                                       |
|------------------|------------------|-------------------------------------------------------------------|
| `connected`      | Server -> Client | Sent on successful WS open. Contains `jid` identifier.            |
| `auth_challenge` | Server -> Client | SIWS handshake challenge. Contains `nonce`, `agentName`, `agentAsset`, `network`, `authMode`, timestamps. |
| `authenticated`  | Server -> Client | Handshake succeeded. Contains `walletAddress`, `isOwner`, `sessionId`. |
| `auth_error`     | Server -> Client | Handshake failed. Contains `code` (one of `nonce_expired`, `nonce_invalid`, `message_mismatch`, `signature_invalid`, `not_authorized`, `auth_timeout`) and `message`. Socket is closed with code `4001`. |
| `message`        | Server -> Client | Agent's chat response. Contains `content` and `sender` name.     |
| `typing`         | Server -> Client | Typing indicator. `isTyping: true` when processing starts, `false` when done. |
| `transaction`    | Server -> Client | Base64-encoded Solana transaction for wallet signing. Optional `message`, `index`, `total`, `feeSol`. |
| `error`          | Server -> Client | Error response for invalid client messages.                       |

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

Authentication is performed via Sign-In-With-Solana (SIWS) immediately after the WebSocket handshake. The full protocol is in [`WEBSOCKET_PROTOCOL.md`](../../WEBSOCKET_PROTOCOL.md); the short version:

1. Client opens `ws://host:port` (no query param, no bearer header — those are gone).
2. Server sends `auth_challenge` with a single-use nonce.
3. Client signs the canonical SIWS message with their Solana wallet.
4. Client sends `auth_response { publicKey, signature, message }`.
5. Server verifies the Ed25519 signature, checks the wallet against the active tier, and either sends `authenticated` or `auth_error` + closes with `4001`.

Authorization tier is controlled by `AGENT_AUTH_MODE`:

| Tier | Allowed wallets |
|---|---|
| `owner` | On-chain asset owner only (autonomous default) |
| `allowlist` | Owner + entries in `wallets.allowlist.json` and/or `WALLET_ALLOWLIST` env (public default if list is set) |
| `open` | Any wallet that completes SIWS (public default when no allowlist) |

The owner is always allowed regardless of tier.

## Wallet State Management

The connecting wallet is bound to the session at SIWS auth time and stays fixed for the connection's lifetime. Each WebSocket connection is its own session — `walletAddress`, conversation history, and pending-tx queue all live on the session object, not on the server singleton. Multiple users can connect concurrently without interfering.

If you need a different wallet on the same browser, close the WebSocket and reconnect; the new connection re-runs the SIWS handshake.

## File Structure

```
packages/server/
  src/
    index.ts       # Entry point -- instantiates and starts PlexChatServer
    websocket.ts   # PlexChatServer class with all protocol handling
  package.json
```
