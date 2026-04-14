# Agent Template Design

Date: 2026-04-13

## Purpose

A reusable template for building agents that integrate with the Metaplex Agent Registry. Uses Mastra as the agent framework, pnpm/TypeScript for tooling, and Metaplex Umi as the Solana framework. Agents communicate with the frontend via the PlexChat WebSocket protocol.

## Agent Modes

Two modes controlled by `AGENT_MODE` env var:

- **Public (1-to-many)**: One agent serves many users. No agent keypair. Builds transactions and sends them over WebSocket for the user's connected wallet to sign. Examples: wallet cleanup agent, devnet faucet.
- **Autonomous (1-to-1)**: Agent has its own keypair and executes transactions server-side. Examples: portfolio balancer, trading bot.

## Project Structure

```
014-agent-template/
  packages/
    core/          - Mastra agent, tools, system prompt
    server/        - WebSocket server (PlexChat protocol)
    shared/        - Protocol types, Umi factory, transaction helpers
  docs/
    plans/         - Design documents
  WEBSOCKET_PROTOCOL.md  - Canonical protocol spec
  package.json     - pnpm workspace root
  tsconfig.json    - Base TS config
  .env.example     - All env vars documented
  README.md        - Getting started, architecture overview
```

## Package Responsibilities

### packages/shared

- TypeScript types for all PlexChat protocol messages (client→server and server→client)
- `createUmi()` factory: configures Umi based on AGENT_MODE (no signer for public, keypair signer for autonomous)
- `TransactionSender` interface: abstraction for how transactions reach the user
- `submitOrSend()` helper: in public mode, serializes and sends via TransactionSender; in autonomous mode, signs and submits to RPC
- Umi helper utilities (connection, token lookups, etc.)

### packages/core

- Mastra agent definition with configurable LLM provider
- System prompt (generic, designed to be replaced)
- Starter tools:
  - `getBalance` — SOL balance for an address
  - `getTokenBalances` — All SPL token holdings
  - `transferSol` — Transfer SOL
  - `transferToken` — Transfer SPL tokens
  - `getTransaction` — Look up transaction by signature
- Tools use shared Umi helpers and are mode-agnostic

### packages/server

- WebSocket server using `ws` library on configurable port
- Full PlexChat protocol implementation:
  - Token-based auth (query param or Authorization header)
  - Connection lifecycle (connected, error, close)
  - Message routing → Mastra agent invocation
  - Wallet state management (connect/disconnect, global scope)
  - Typing indicators
  - Transaction bridge (injects TransactionSender into agent context)
- Entry point: `src/index.ts`

## Transaction Flow

### Public Mode
1. User sends chat message via WebSocket
2. Server invokes Mastra agent with message + wallet address
3. Tool builds transaction using Umi
4. Tool calls `submitOrSend()` which serializes the transaction
5. TransactionSender pushes `transaction` message to all WS clients
6. Frontend wallet signs and submits

### Autonomous Mode
1. User sends chat message via WebSocket
2. Server invokes Mastra agent with message
3. Tool builds transaction using Umi
4. Tool calls `submitOrSend()` which signs with agent keypair and submits to RPC
5. Tool returns transaction signature
6. Agent reports result to user

## Configuration

```
AGENT_MODE=public              # "public" or "autonomous"
LLM_PROVIDER=anthropic         # anthropic | openai | google
LLM_MODEL=claude-sonnet-4-5-20250929
LLM_API_KEY=
SOLANA_RPC_URL=https://api.devnet.solana.com
AGENT_KEYPAIR=                 # Base58 secret key (autonomous mode only)
WEB_CHANNEL_PORT=3002
WEB_CHANNEL_TOKEN=             # Shared auth secret
ASSISTANT_NAME=Agent
```

## Documentation

- Root README.md — Overview, quickstart, architecture, env vars
- packages/core/README.md — Adding tools, modifying the agent
- packages/server/README.md — Server config, protocol reference, deployment
- packages/shared/README.md — Umi helpers, transaction patterns, types
