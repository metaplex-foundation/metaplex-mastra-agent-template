# Metaplex Agent Template - Product Requirements Document

**Version:** 1.1
**Last Updated:** 2026-04-17
**Status:** Living Document

---

## 1. Overview

### 1.1 What Is This

The Metaplex Agent Template is a full-stack starter kit for building AI agents on Solana that register on the [Metaplex Agent Registry](https://agents.metaplex.com). It provides a ready-to-run agent with blockchain tools, a real-time WebSocket communication layer, and a test UI -- designed to be forked and extended.

### 1.2 Problem Statement

Developers building AI agents that interact with Solana face fragmented tooling: they must wire together an LLM framework, a Solana client library, a real-time communication protocol, wallet signing flows, and an on-chain identity system. There is no canonical starting point that handles all of these concerns together.

### 1.3 Solution

A pnpm monorepo template that integrates:

- **Mastra** as the AI agent framework (model routing, tool execution, streaming)
- **Metaplex Umi** as the Solana toolkit (transaction building, RPC, signing)
- **Metaplex Agent Registry** for on-chain agent identity
- **Metaplex Genesis** for bonding-curve token launches
- **Jupiter** for DEX swaps and price data
- **PlexChat** WebSocket protocol for frontend communication
- **Solana Wallet Adapter** for user transaction signing

Out of the box, developers get a working agent that can check balances, transfer tokens, swap on Jupiter, register on-chain, launch its own token, and manage its treasury -- ready to customize with domain-specific tools and prompts.

---

## 2. Architecture

### 2.1 Monorepo Structure

```
metaplex-agent-template/
  packages/
    shared/    @metaplex-agent/shared    Foundation layer (config, Umi, types, helpers)
    core/      @metaplex-agent/core      Agent definition, system prompt, tool registry
    server/    @metaplex-agent/server     WebSocket server (PlexChat protocol)
    ui/        @metaplex-agent/ui         Next.js test frontend
```

### 2.2 Dependency Graph

```
ui ──► shared (devDependency for types)
server ──► core ──► shared
```

- `shared` has zero internal dependencies (it is the foundation)
- `core` depends on `shared` for config, Umi factory, transaction helpers, and types
- `server` depends on `core` (agent instance) and `shared` (config, types)
- `ui` depends on `shared` as a devDependency (protocol types only)

### 2.3 Data Flow

```
User (Browser/WS Client)
  │
  │  PlexChat WebSocket (JSON over WS)
  ▼
PlexChatServer (@metaplex-agent/server)
  │
  │  Mastra agent.stream() with RequestContext
  ▼
Mastra Agent (@metaplex-agent/core)
  │
  │  Tool execution with AgentContext
  ▼
Tools ──► Umi (Solana RPC) / Jupiter API / Agent Registry
  │
  │  submitOrSend() routes by mode
  ▼
Public: serialize tx ──► WebSocket ──► user wallet signs ──► Solana
Autonomous: agent signs ──► sendAndConfirm() ──► Solana
```

---

## 3. Agent Modes

The template supports two operating modes, controlled by the `AGENT_MODE` environment variable. The distinction is **purely about transaction routing** -- both modes share the same identity model, tools, and capabilities.

### 3.1 Public Mode (`AGENT_MODE=public`)

**Target use case:** Agents where end users sign their own transactions. Supports multiple concurrent users on the same server instance; each WebSocket connection has its own wallet, conversation history, and transaction queue.

**Behavior:**
- Agent builds transactions with the user's wallet as fee payer (using a NoopSigner placeholder)
- Transactions are serialized to base64 and sent to the frontend over WebSocket
- The frontend wallet (Phantom, Solflare) prompts the user to sign
- A configurable SOL fee (`AGENT_FEE_SOL`, default 0.001) is atomically prepended to each transaction, paid to the agent's PDA wallet
- Additional tools available: `transfer-sol`, `transfer-token` (user-facing transfers)

`launch-token` is always agent-signed (see §10.5); the agent pays the launch cost from its PDA/keypair. The user does not sign the launch transactions.

**Example use cases:** Wallet cleanup bots, faucet agents, NFT minting assistants, token launch assistants, portfolio advisors.

### 3.2 Autonomous Mode (`AGENT_MODE=autonomous`)

**Target use case:** Agents that act independently with their own funds, controlled by their owner.

**Behavior:**
- **Only the asset owner can interact.** All other connections are rejected at the WebSocket layer before the LLM is ever invoked (see §3.4 Owner Resolution, §5.3 Tool Authorization).
- Agent signs and submits all transactions itself using its keypair
- Owner must connect their wallet via `wallet_connect` to be verified
- No fee prepending (agent self-funds)
- Trading funds sit in the agent's keypair wallet

**Example use cases:** Portfolio rebalancers, trading bots, automated treasury managers, DeFi strategy agents.

### 3.3 Mode Comparison

| Aspect | Public | Autonomous |
|---|---|---|
| Transaction signing | User signs in wallet UI | Agent signs with keypair |
| Fee model | Prepends SOL fee to user txs | Self-funded from keypair |
| User wallet required | Yes (connected via UI) | No |
| Transfer tools available | Yes (`transfer-sol`, `transfer-token`) | No |
| `submitOrSend()` returns | Transaction signature (base58) after user signs | Transaction signature (base58) |

### 3.4 Owner Resolution

The **owner** of an agent is the wallet address that owns the agent's MPL Core asset on the Metaplex Agent Registry. This is the canonical source of truth for authorization.

**Resolution order:**

1. **On-chain asset** (primary) -- fetch the MPL Core asset at `agentAssetAddress` and read its `owner` field. Cached in memory after first fetch.
2. **`BOOTSTRAP_WALLET` env var** (bootstrap fallback) -- used only when `agentAssetAddress` is not yet set (agent has not registered). Required for autonomous mode pre-registration; the server refuses to start in autonomous mode without either `BOOTSTRAP_WALLET` or a persisted `agentAssetAddress`.
3. **`null`** -- no owner resolved. In autonomous mode, all interactions are rejected. In public mode, all tools are available (no owner-gated restrictions apply).

**Bootstrap edge case:** Before registration, no on-chain asset exists, so there is no on-chain owner. The `BOOTSTRAP_WALLET` env var bridges this gap. Once the agent registers and `agentAssetAddress` is persisted, the on-chain owner takes precedence and `BOOTSTRAP_WALLET` is no longer consulted.

---

## 4. Agent Identity Model

### 4.1 Unified Identity

Every agent (regardless of mode) has:

| Component | Description |
|---|---|
| **Keypair** | Solana keypair that serves as the executive authority. Authorizes on-chain operations. |
| **Agent Asset** | An MPL Core asset minted on the Metaplex Agent Registry. The agent's on-chain identity. |
| **Asset Signer PDA** | A program-derived address derived from the agent asset. The agent's real wallet -- holds funds, receives fees, stores treasury. |
| **Token** (optional) | A bonding-curve token launched via Metaplex Genesis. One per agent, irreversible. Creator fees flow to the PDA. |

### 4.2 Bootstrap Sequence

On the agent's very first interaction, the system prompt directs it to:

1. **Check registration** -- if `AGENT_ASSET_ADDRESS` is already set, skip to step 4
2. **Register** -- call `register-agent` to mint an MPL Core asset on the Agent Registry
3. **Delegate execution** -- call `delegate-execution` to set up executive signing authority, linking the keypair to the asset
4. **Confirm** -- inform the user that the agent is registered and ready

**Funding flow (public mode):** If the agent's keypair has insufficient SOL for registration, and a user wallet is connected, the agent sends a 0.02 SOL funding transaction to the user's wallet. When the user approves, the agent receives an automatic notification and retries registration without further user prompting.

### 4.3 State Persistence

Agent identity persists across restarts via `agent-state.json` at the project root:

```json
{
  "agentAssetAddress": "ARsZN4kZUWNX8Ek5ZkVUpRitSFjym6p9jLvUxrg9kPWU",
  "agentTokenMint": "4rdwM8kCYKxsDf3hyqsmE4MMEsyT3bhbpXCVm71wPLEX"
}
```

**Resolution order** (for both fields):
1. `.env` value (operator override, always wins)
2. `agent-state.json` value (auto-persisted by tools)
3. `null` (not yet registered/launched)

Tools automatically write to `agent-state.json` after key operations (`register-agent` writes `agentAssetAddress`, `launch-token` writes `agentTokenMint`).

---

## 5. Tools

### 5.1 Tool Inventory

All tools are defined with Mastra's `createTool()` pattern using Zod schemas for input/output validation.

#### Shared Tools (both modes) -- 12 tools

| Tool | Category | Auth | Description |
|---|---|---|---|
| `get-balance` | Query | `public` | SOL balance for any wallet address |
| `get-token-balances` | Query | `public` | All SPL token holdings for any address (with decimals) |
| `get-transaction` | Query | `public` | Transaction status lookup by signature |
| `get-token-price` | Query | `public` | Current USD price for any token via Jupiter Price API |
| `get-token-metadata` | Query | `public` | Token name, symbol, and image via DAS API |
| `sleep` | Utility | `public` | Pause 1-300 seconds (for monitoring/polling loops) |
| `register-agent` | Identity | `owner` | Mint an MPL Core asset on the Metaplex Agent Registry |
| `delegate-execution` | Identity | `owner` | Set up executive profile and link keypair to agent asset |
| `launch-token` [^agent-signed] | Treasury | `owner` | Launch a bonding-curve token via Metaplex Genesis |
| `swap-token` | Treasury | `owner` | Swap any tokens via Jupiter DEX |
| `buyback-token` | Treasury | `owner` | Buy the agent's own token (SOL -> token) |
| `sell-token` | Treasury | `owner` | Sell the agent's own token (token -> SOL) |

#### Public-Only Tools -- 2 tools

| Tool | Category | Auth | Description |
|---|---|---|---|
| `transfer-sol` | Transfer | `public` | Send SOL from user's wallet to a destination |
| `transfer-token` | Transfer | `public` | Send SPL tokens from user's wallet (auto-creates destination ATA) |

#### Tool Assignment

- **Public mode:** shared (12) + public (2) = **14 tools**
- **Autonomous mode:** shared (12) = **12 tools**

[^agent-signed]: Agent-signed in both modes; requires `confirmIrreversible: true` input for safety. See §6.6 and §10.5.

### 5.2 Adding New Tools

1. Create a `.ts` file in `packages/core/src/tools/shared/` (or `public/`)
2. Define the tool with `createTool()` from `@mastra/core/tools`
3. Import and add to the tool registry in the corresponding `index.ts`
4. Mastra auto-exposes registered tools to the LLM

For tools that write transactions, use `submitOrSend()` from `@metaplex-agent/shared` -- it handles both modes automatically. See `transfer-sol.ts` for the reference pattern.

For consistent tool output shape, use the `ok()`, `info()`, and `err()` helpers from `@metaplex-agent/shared` (see `packages/shared/src/types/tool-result.ts`). Every tool return should be one of:

- `ok({ ... })` -- successful result with a `status: 'success'` discriminator
- `info({ ... })` -- informational / already-done result with `status: 'info'`
- `err(code, message)` -- failure with `status: 'error'`, a typed `ToolErrorCode`, and a human-readable message

This gives the LLM a reliable `status` field to branch on and makes error handling uniform across tools.

### 5.3 Tool Authorization

Tool authorization is enforced **programmatically** at the tool execution layer -- not via the system prompt. This ensures that prompt injection and social engineering cannot bypass access controls.

#### Authorization Levels

Each tool declares an `auth` level in its metadata (a simple string). The template ships with two levels:

| Level | Meaning |
|---|---|
| `public` | Any connected client can trigger this tool |
| `owner` | Only the verified asset owner can trigger this tool |

Developers can define additional levels (e.g., `admin`, `subscriber`) by extending the authorization policy.

#### Authorization Policy

Policies are functions that evaluate whether a tool execution is allowed:

```typescript
type AuthPolicy = (authLevel: string, context: AgentContext) => boolean;
```

The default policy:

```typescript
const defaultPolicy: AuthPolicy = (level, ctx) => {
  if (level === 'public') return true;
  if (level === 'owner') return ctx.ownerWallet !== null && ctx.connectedWallet === ctx.ownerWallet;
  return false; // unknown levels are denied by default
};
```

The `ownerWallet !== null` guard fails closed when owner resolution has not yet succeeded (e.g., pre-registration without `BOOTSTRAP_WALLET`, or a failed on-chain owner lookup). Without the guard, a `null === null` comparison would spuriously allow owner-level tools.

Developers can replace the policy entirely to implement custom authorization logic. Unknown auth levels are denied by default (fail-closed).

#### Enforcement Layers

Authorization operates at three independent layers. Any single layer is sufficient to block unauthorized access:

```
Layer 1: Connection Gate (PlexChatServer)
  └─ Autonomous mode: only owner wallet can interact at all
  └─ Public mode: open (anyone can connect)

Layer 2: Tool Auth Policy (tool execution wrapper)
  └─ Checks tool's auth level against the authorization policy
  └─ Returns "This operation requires owner authorization" on failure

Layer 3: Transaction Routing (submitOrSend)
  └─ Public mode: user signs their own transactions (inherent safety)
  └─ Autonomous mode: agent signs (protected by layers 1 and 2)
```

In autonomous mode, Layer 1 (connection gate) prevents the LLM from ever being invoked by a non-owner. Layer 2 (tool auth) serves as defense-in-depth. In public mode, Layer 1 is open, so Layer 2 is the primary enforcement point for `owner`-level tools.

---

## 6. Communication Protocol (PlexChat)

### 6.1 Overview

The server exposes a WebSocket endpoint implementing the PlexChat protocol for bidirectional, real-time communication between frontends and the agent.

**Endpoint:** `ws://<host>:<port>/?token=<auth-token>`
**Default port:** 3002

### 6.2 Authentication

Three methods supported (the server accepts any of them; the client picks one):

- **WebSocket subprotocol** (recommended for production): send `Sec-WebSocket-Protocol: bearer, <token>` in the handshake (in-browser: `new WebSocket(url, ['bearer', token])`). The server validates the second subprotocol entry and echoes `bearer` back on accept. Unlike the query param, the token is not recorded in URL access logs, browser history, or Referer headers.
- **Authorization header:** `Authorization: Bearer <token>` (works for non-browser WS clients that can set custom headers).
- **Query parameter** (convenience for local dev and CLI tools like `wscat`): `?token=<value>`. Discouraged in production because the token leaks through logs, history, and Referer.

`WEB_CHANNEL_TOKEN` must be at least 32 characters. Unauthorized connections receive close code `4001` with reason `"Unauthorized"`.

### 6.3 Client -> Server Messages

| Type | Purpose | Key Fields |
|---|---|---|
| `message` | Send chat message to agent | `content` (required), `sender_name` (optional) |
| `wallet_connect` | Notify server of connected wallet; triggers owner verification in autonomous mode | `address` (required, base58 pubkey) |
| `wallet_disconnect` | Clear connected wallet | (no fields) |
| `tx_result` | Report signed and submitted transaction signature | `correlationId` (required), `signature` (required) |
| `tx_error` | Report failed/rejected transaction | `correlationId` (required), `reason` (optional) |

### 6.4 Server -> Client Messages

All server -> client messages are unicast to the originating session. There is no cross-session broadcast — each WebSocket connection is isolated.

| Type | Delivery | Purpose |
|---|---|---|
| `connected` | Unicast | Connection acknowledged, includes `jid` |
| `message` | Unicast | Agent chat response (may contain markdown) |
| `typing` | Unicast | Agent processing indicator (`isTyping: true/false`) |
| `transaction` | Unicast | Base64-encoded Solana tx for wallet signing. `correlationId` is always set; `feeSol` is included in public mode when the agent fee is prepended. |
| `wallet_connected` | Unicast | Confirms wallet connection with `address` |
| `wallet_disconnected` | Unicast | Confirms wallet disconnection |
| `error` | Unicast | Error for invalid client messages |
| `debug:*` | Unicast | Real-time execution telemetry for this session (see 6.5) |

### 6.5 Debug Events

The server streams granular execution telemetry for frontend developer tools:

| Event | Data |
|---|---|
| `debug:step_start` | Step number, type (initial/tool-result) |
| `debug:tool_call` | Tool name, arguments, call ID |
| `debug:tool_result` | Tool name, result, error flag, duration |
| `debug:text_delta` | Streaming text chunks from LLM |
| `debug:step_complete` | Finish reason, token usage, duration |
| `debug:generation_complete` | Total steps, aggregated usage, trace ID |
| `debug:context` | Agent mode, model, tools, wallet, client count |

### 6.6 Transaction Signing Flow (Public Mode)

Transaction submission is **awaitable** from the tool's point of view. Tools call `submitOrSend()` and receive the confirmed signature directly — no polling, no synthetic system messages.

```
1. Agent tool builds a transaction with a NoopSigner for the connected user wallet.
2. Tool calls submitOrSend(umi, builder, context, {message?}). In public mode this
   serializes the builder to base64, prepends the configured agent SOL fee when the
   agent is registered, and returns a Promise<string> resolving to the signature.
3. Server assigns a unique correlationId and sends to the session:
     { type: "transaction", transaction: "<base64>", correlationId,
       feeSol?, message?, index?, total? }
   The Promise returned by submitOrSend remains pending in a per-session map keyed
   by correlationId.
4. Frontend decodes the transaction, presents it to the user, and has the wallet
   (Phantom, Solflare, ...) sign it. The frontend submits the signed tx to the
   Solana RPC endpoint.
5. On success, the frontend sends { type: "tx_result", correlationId, signature }.
   On rejection or error, it sends  { type: "tx_error", correlationId, reason }.
6. Server looks up the pending entry by correlationId and either resolves the
   Promise with the signature or rejects it with an Error whose message is the
   sanitized reason. Unknown correlationIds are dropped with an error event.
7. submitOrSend returns the signature (success path) or the tool throws
   (rejection path). The LLM sees the real signature or a tool failure — no
   prompt-injection surface via synthetic [System: ...] prefixes.
8. Timeout: if the user does not respond within 5 minutes, the server rejects
   the Promise with a timeout error and removes the pending entry. The tool
   surfaces this as a failure to the LLM, which can retry or report to the user.
```

For multi-transaction flows, tools may pass `index`/`total` on each `submitOrSend` call so the frontend can render "Transaction N of M" progress. Each still has its own `correlationId`.

**Tools that do NOT flow through this path (agent-signed in both modes):**

- **`launch-token`** -- always agent-signed. The Metaplex Genesis SDK composes multiple instructions into agent-signed transactions; the agent pays the launch cost from its PDA/keypair. See §10.5. Requires `confirmIrreversible: true` on the tool input.
- **`swap-token`, `buyback-token`, `sell-token`** -- Jupiter versioned transactions that the agent signs directly (see §10.4).

The `index`/`total` fields remain available for other multi-tx tools that do route through this user-signing flow.

### 6.7 State Management

- **Wallet state:** Per-session (each WebSocket connection has its own). A second client connecting to the same server never sees the first client's wallet address.
- **Conversation history:** Per-session, in-memory, lost on restart. Two users chatting simultaneously do not share context.
- **Connection state:** Independent per WebSocket client.
- **Pending transactions:** Per-session map keyed by `correlationId`. Cleared on disconnect (all pending promises rejected).
- **Owner cache:** Process-global (keyed by `agentAssetAddress`, not session). See §3.4.

---

## 7. Frontend (Test UI)

### 7.1 Purpose

A lightweight Next.js application for testing agent interactions without the full metaplex.com frontend. Not intended as a production UI.

### 7.2 Stack

- Next.js 15.3 (App Router, React 19)
- Tailwind CSS 4.0
- Solana Wallet Adapter (Phantom, Solflare)
- `@solana/web3.js` 1.x
- react-markdown for message rendering

### 7.3 Components

| Component | Description |
|---|---|
| `page.tsx` | Main page combining chat, wallet connection, and transaction approval |
| `providers.tsx` | Solana wallet adapter context providers |
| `chat-panel.tsx` | Scrollable message list with input textarea, smart auto-scroll |
| `chat-message.tsx` | Message bubbles (user: blue/right, agent: dark/left) with markdown |
| `typing-indicator.tsx` | Animated bouncing dots |
| `transaction-approval.tsx` | Modal overlay for signing transactions (states: pending -> signing -> sending -> confirming -> success/error) |
| `debug/` | Multi-tab debug panel (Steps, Context, Messages, Totals) toggled via Cmd+D |

### 7.4 Hooks

| Hook | Description |
|---|---|
| `use-plexchat` | WebSocket connection management, auto-reconnect with exponential backoff (1s-10s), message streaming via `debug:text_delta`, wallet sync, transaction callbacks |
| `use-debug-panel` | Execution trace collection, token usage tracking, session totals, persisted open state |

---

## 8. Configuration

### 8.1 Environment Variables

All configuration is via environment variables, validated at startup with Zod schemas.

#### Required

| Variable | Description |
|---|---|
| `AGENT_KEYPAIR` | Base58-encoded secret key (or JSON byte array) for the agent wallet |
| `WEB_CHANNEL_TOKEN` | Shared secret for WebSocket authentication. **Must be at least 32 characters.** Generate with `openssl rand -hex 24` (48 hex chars) or `openssl rand -hex 32` (64 hex chars). |
| LLM API Key | One of: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` |

#### Optional (with defaults)

| Variable | Default | Description |
|---|---|---|
| `AGENT_MODE` | `public` | `"public"` or `"autonomous"` |
| `LLM_MODEL` | `anthropic/claude-sonnet-4-5-20250929` | Mastra model identifier (`provider/model` format) |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Solana JSON-RPC endpoint |
| `WEB_CHANNEL_PORT` | `3002` | WebSocket server port |
| `ASSISTANT_NAME` | `Agent` | Display name in chat responses |
| `AGENT_FEE_SOL` | `0.001` | SOL fee per user transaction (public mode only) |
| `MAX_STEPS` | `10` | Maximum number of LLM + tool execution steps per user message |
| `MAX_CONNECTIONS` | `10` | Maximum concurrent WebSocket sessions the server accepts |
| `ENABLE_DEBUG_EVENTS` | `true` | Stream `debug:*` telemetry events to the session |
| `MAX_SLIPPAGE_BPS` | `500` | Upper cap on `slippageBps` accepted by swap/buyback/sell tools |
| `MAX_PRICE_IMPACT_PCT` | `2.0` | Upper cap on Jupiter `priceImpactPct` accepted before a quote is rejected |
| `OWNER_CACHE_TTL_MS` | `300000` | TTL for cached on-chain owner lookups (5 minutes) |
| `WS_ALLOWED_ORIGINS` | `http://localhost:3001,http://localhost:3000` | Comma-separated list of allowed WebSocket `Origin` headers. Rejects cross-site connections (CSWSH protection). Missing/undefined origins (curl, wscat) are allowed with a warning. |
| `MAX_MESSAGE_CONTENT` | `8000` | Per-message character cap on inbound chat `content`. Rejects oversized messages before they enter conversation history. |
| `MAX_RPC_TIME_BUDGET_MS` | `60000` | Per-message cumulative RPC wall-clock budget. When exceeded, the current LLM turn is aborted. Bounds runaway tool loops. |
| `LOG_AUTH_FAILURES` | `true` | Emit structured `console.warn` logs on token mismatch, origin rejection, autonomous-gate denial, and rate-limit breach. |

#### Optional (no default)

| Variable | Description |
|---|---|
| `BOOTSTRAP_WALLET` | Base58 pubkey of the wallet allowed to bootstrap the agent. Required for autonomous mode pre-registration — the server refuses to start in autonomous mode without either `BOOTSTRAP_WALLET` or a persisted `AGENT_ASSET_ADDRESS`. Once registered, the on-chain asset owner takes precedence (see §3.4). |
| `AGENT_ASSET_ADDRESS` | Operator override for registry address (auto-persisted otherwise) |
| `AGENT_TOKEN_MINT` | Operator override for token mint (auto-persisted otherwise) |
| `TOKEN_OVERRIDE` | Target a specific token for buybacks (e.g., MPLX) instead of launching |
| `JUPITER_API_KEY` | Jupiter API key for price data and swap quotes |
| `AGENT_FUNDING_SOL` | Override for the SOL amount sent to the agent wallet during `register-agent` funding (default `0.02`) |
| `AGENT_FUNDING_THRESHOLD_SOL` | Balance threshold below which `register-agent` triggers the funding flow (default `0.01`) |

### 8.2 UI Environment (packages/ui/.env.local)

| Variable | Default | Description |
|---|---|---|
| `NEXT_PUBLIC_WS_HOST` | `localhost` | WebSocket server host |
| `NEXT_PUBLIC_WS_PORT` | `3002` | WebSocket server port |
| `NEXT_PUBLIC_WS_TOKEN` | -- | Must match `WEB_CHANNEL_TOKEN` (≥ 32 chars) |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Solana RPC for wallet adapter |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | `devnet` | Cluster used to build Solana Explorer links for transactions. One of `mainnet-beta`, `devnet`, `testnet`. |

---

## 9. System Prompt Design

### 9.1 Structure

A single shared base prompt with a short mode-specific addendum, composed at agent creation time via `buildSystemPrompt(mode)`.

### 9.2 Base Prompt Covers

- **Bootstrap sequence** -- mandatory registration and delegation on first interaction
- **Funding flow** -- automatic retry after user approves funding transaction
- **Identity model** -- keypair, asset signer PDA, on-chain identity
- **Available tools** -- full inventory with usage guidance
- **Token launch** -- irreversibility warning, mandatory user confirmation, TOKEN_OVERRIDE awareness
- **Treasury management** -- buyback/sell/swap guidance, fee awareness
- **Price watching** -- sleep-loop polling pattern with user narration
- **Portfolio analysis** -- balance + tokens + prices + USD valuation

### 9.3 Mode Addendums

**Public:** Explains that transactions go to user's wallet for signing, fees are prepended automatically, transfer tools are available.

**Autonomous:** Explains that the agent signs everything itself, trading funds sit in the keypair wallet, no user wallet concept.

---

## 10. Key Design Decisions

### 10.1 Unified Identity Model

Both modes share identical agent identity (keypair + asset + PDA + optional token). The only difference is how transactions are routed. This eliminates code duplication and ensures both modes benefit from the same identity, treasury, and token capabilities.

### 10.2 Atomic Fee Prepending

In public mode, the agent's operational fee is prepended as a SOL transfer instruction to every user transaction. The user signs one transaction that atomically covers both the fee and the operation. This is simpler than separate fee transactions and ensures the agent always gets paid when the user approves an action.

### 10.3 NoopSigner Pattern

In public mode, transactions are built with a NoopSigner placeholder for the user's wallet address. This allows Umi to construct valid transactions without the actual signing key. The frontend deserializes and has the real wallet sign before submission.

### 10.4 Jupiter Versioned Transactions

Jupiter returns complete versioned transactions that cannot be decomposed into individual instructions for CPI routing through the asset signer PDA. Therefore, all swap/buyback/sell operations use the agent's keypair wallet directly, not the PDA.

**Simulation-based integrity check.** Because the agent signs a Jupiter-returned transaction opaquely, a compromised Jupiter response (or a man-in-the-middle between the agent and the Jupiter HTTPS endpoint) could in principle substitute arbitrary routes that drain the agent's wallet. Full instruction decomposition is impractical -- Jupiter routes through many DEX programs (Raydium, Orca, Meteora, Serum, Phoenix, ...) each with its own instruction layout.

Instead, before signing and sending, the agent runs `simulateTransaction` with `replaceRecentBlockhash` and inspects the agent's own input and output token account balances pre- and post-simulation. The helper asserts:

- The input-mint debit from the agent's ATA is ≤ `params.amount` (plus a small fee/rounding buffer).
- The output-mint credit to the agent's ATA is ≥ Jupiter's quoted `expectedMinOutAmount` (minus a small buffer).
- No other agent-owned token accounts show unexpected movement.

On mismatch, the tool throws with `err('INTEGRITY', ...)` and never signs. This works regardless of which DEX Jupiter routes through, because the check is on the net balance delta for the agent's wallet, not on the underlying swap instructions.

### 10.5 Launch-Token Signing

`launch-token` is always agent-signed, regardless of mode. The Metaplex Genesis SDK composes the multi-step launch (mint creation, metadata, bonding-curve setup, etc.) into transactions signed by the agent keypair -- they cannot be repackaged into user-signed txs without forking the SDK. In public mode, the user does not sign the launch transactions; the agent pays the launch cost from its own balance.

For safety, the tool requires an explicit `confirmIrreversible: true` input so the LLM cannot accidentally launch a token without explicit user confirmation surfaced in tool arguments. Token launches are irreversible on-chain; the system prompt also instructs the agent to obtain the user's confirmation before calling the tool.

### 10.6 Token Override

The `TOKEN_OVERRIDE` env var allows hosted agents (e.g., on metaplex.com) to target a specific existing token for buyback operations (e.g., MPLX) instead of launching their own. When set, `launch-token` correctly rejects, and `buyback-token`/`sell-token` target the override mint.

### 10.7 State File Over Database

Agent state (`agentAssetAddress`, `agentTokenMint`) is persisted to a simple JSON file rather than a database. This keeps the template dependency-free and file-system-portable. The state file is auto-generated and gitignored.

### 10.8 Per-Session State

Every WebSocket connection gets its own `Session` object — not a share of a server-wide singleton. Each session owns its wallet address, conversation history, processing flag, abort controller, pending transactions map (keyed by `correlationId`), and pending message queue. The agent instance, owner cache, and rate-limiter state remain process-global because they are either stateless between calls or genuinely cross-cutting.

This design has three concrete consequences:

1. **Multi-user safety in public mode.** Client A asking about their wallet cannot leak A's balance, holdings, or signatures to Client B. A second connection never inherits A's history or typing state.
2. **No sticky owner verification in autonomous mode.** `isOwnerVerified` is per-session, so once an owner-verified client disconnects, a subsequent non-owner connection starts with `isOwnerVerified=false` and is rejected at the connection gate (§5.3, Layer 1).
3. **Clean shutdown on disconnect.** When a session closes, its abort controller is fired, its pending transactions are rejected with a "client disconnected" error, and its `aliveCheck` interval is cleared. No orphaned promises or memory leaks.

Conversation persistence across restarts is still out of scope (see §12.5); per-session state is strictly in-memory.

---

## 11. Developer Workflow

### 11.1 Getting Started

```bash
git clone <repo-url> my-agent
cd my-agent
pnpm install
cp .env.example .env
# Edit .env with API keys, keypair, and token
pnpm dev          # Server on ws://localhost:3002
pnpm dev:all      # Server + UI on http://localhost:3001
```

### 11.2 Development Commands

| Command | Description |
|---|---|
| `pnpm dev` | Build shared + core, start server with hot reload (`tsx watch`) |
| `pnpm dev:ui` | Start test UI on http://localhost:3001 |
| `pnpm dev:all` | Start both server and UI together |
| `pnpm build` | Build all packages (TypeScript compilation) |
| `pnpm typecheck` | Type-check all packages without emitting |
| `pnpm clean` | Remove `dist/` and `.next/` from all packages |

### 11.3 Customization Points

| What to change | Where |
|---|---|
| Agent personality / system prompt | `packages/core/src/prompts.ts` |
| LLM provider and model | `.env` (`LLM_MODEL` + API key) |
| Add new tools | `packages/core/src/tools/shared/` or `public/` |
| Agent name | `.env` (`ASSISTANT_NAME`) |
| Fee amount | `.env` (`AGENT_FEE_SOL`) |
| Solana network | `.env` (`SOLANA_RPC_URL`) |
| WebSocket port | `.env` (`WEB_CHANNEL_PORT`) |

---

## 12. Production Considerations

### 12.1 Transport Security

The WebSocket server runs unencrypted (`ws://`) by default. In production, terminate TLS at a reverse proxy (nginx, Caddy) for `wss://`.

### 12.2 Authentication & Authorization

The template includes a layered authorization system (see §5.3) that enforces access control programmatically:

- **Autonomous mode** is owner-gated at the connection level -- non-owners cannot interact
- **Public mode** uses per-tool auth levels to restrict treasury operations to the owner
- **Owner identity** is derived from the on-chain agent asset, with `BOOTSTRAP_WALLET` as a bootstrap fallback

The WebSocket transport uses a single shared token (`WEB_CHANNEL_TOKEN`, ≥ 32 chars). For production deployments:

- **Use subprotocol or Authorization-header auth, not the query param.** The query param leaks the token through reverse-proxy access logs, browser history, and Referer headers. The subprotocol form (`Sec-WebSocket-Protocol: bearer, <token>`) travels only in the WebSocket handshake and is the recommended default for browser clients (see §6.2).
- **Terminate TLS (wss://)** at the reverse proxy so the handshake -- including the subprotocol header -- is encrypted on the wire.
- **Constrain origins.** `WS_ALLOWED_ORIGINS` is validated on connect; set it to exactly the origins that are allowed to open a WebSocket to this server.
- **Consider per-user auth.** For multi-user deployments, issue per-user JWT tokens or session cookies bound to your application's auth system rather than sharing a single token across clients.
- **Rate limiting.** The server already applies per-session rate limits; in front of it, an application-layer gateway (e.g., Cloudflare, a reverse proxy) should rate-limit handshake attempts by IP.

### 12.3 RPC Endpoint

The default `https://api.devnet.solana.com` is rate-limited and development-only. Use a dedicated provider (Helius, QuickNode, Triton) for production and switch to mainnet-beta when ready.

### 12.4 Keypair Security

The `AGENT_KEYPAIR` env var contains a secret key with direct access to funds. In production:
- Use a secrets manager (AWS Secrets Manager, Vault, etc.)
- Never commit to version control
- Restrict file permissions on `.env`
- Fund the agent wallet with only what it needs

### 12.5 Conversation State

Conversation history is in-memory and lost on server restart. For production persistence, implement database-backed conversation storage.

### 12.6 Wallet State Model

Wallet state is per-session — each WebSocket connection has its own `walletAddress`, conversation history, and transaction queue (see §10.8). The public-mode multi-user scenario is supported out of the box; no further work is needed to isolate one user's wallet from another's.

What remains out of scope for the template: cross-connection identity (a single user reconnecting on a new WS does not automatically recover their prior conversation), and durable conversation persistence (see §12.5).

---

## 13. Technology Stack

| Layer | Technology | Version |
|---|---|---|
| Runtime | Node.js | >= 20 |
| Package Manager | pnpm | >= 9 |
| Language | TypeScript | 5.8+ (ES2022 target, strict mode) |
| AI Framework | Mastra | 1.24+ |
| Solana Client | Metaplex Umi | 1.1+ |
| Solana Tools | mpl-toolbox | 0.10+ |
| Agent Registry | mpl-agent-registry | 0.2.5+ |
| Token Launch | Metaplex Genesis | 0.35+ |
| Core Assets | mpl-core | 1.9+ |
| DEX | Jupiter API | v1 (quote) / v3 (price) |
| WebSocket | ws | 8.18+ |
| Frontend | Next.js | 15.3+ |
| UI Framework | React | 19+ |
| Styling | Tailwind CSS | 4.0+ |
| Wallet | Solana Wallet Adapter | latest |
| Validation | Zod | 3.23+ |

---

## Appendix A: PlexChat Message Type Reference

### Client -> Server

```typescript
type ClientMessage =
  | { type: 'message';           content: string; sender_name?: string }
  | { type: 'wallet_connect';    address: string }
  | { type: 'wallet_disconnect' }
  | { type: 'tx_result';         correlationId: string; signature: string }
  | { type: 'tx_error';          correlationId: string; reason?: string };
```

### Server -> Client

```typescript
type ServerMessage =
  | { type: 'connected';            jid: string }
  | { type: 'message';              content: string; sender: string }
  | { type: 'typing';               isTyping: boolean }
  | {
      type: 'transaction';
      transaction: string;          // base64-encoded serialized tx
      correlationId: string;        // required; echoed in tx_result / tx_error
      message?: string;
      index?: number;
      total?: number;
      feeSol?: number;              // present in public mode when fee is prepended
    }
  | { type: 'wallet_connected';     address: string }
  | { type: 'wallet_disconnected' }
  | { type: 'error';                error: string; code?: string }
  | DebugMessage;
```

## Appendix B: Agent Context Shape

The `AgentContext` interface is injected into every tool execution via Mastra's `RequestContext`:

```typescript
interface AgentContext {
  walletAddress: string | null;          // Connected user wallet (null if none)
  transactionSender: TransactionSender | null;  // Sends tx over WS + awaits signature (public mode only)
  agentMode: 'public' | 'autonomous';    // Current operating mode
  agentAssetAddress: string | null;      // On-chain registry address
  agentTokenMint: string | null;         // Agent's token mint address
  agentFeeSol: number;                   // Fee per transaction (public mode)
  tokenOverride: string | null;          // Override buyback target token
  ownerWallet: string | null;            // Resolved owner address (from asset or BOOTSTRAP_WALLET fallback)
}

// TransactionSender is session-scoped; its sendAndAwait returns Promise<string>
// resolving to the base58 signature after the user signs and the client echoes
// the correlationId back via tx_result (or rejects on tx_error / timeout).
interface TransactionSender {
  sendAndAwait(
    transactionBase64: string,
    options?: {
      message?: string;
      index?: number;
      total?: number;
      feeSol?: number;
    },
  ): Promise<string>;
}
```

## Appendix C: File Map

```
metaplex-agent-template/
  .env.example                    Environment variable reference
  agent-state.json                Auto-generated agent identity (gitignored)
  package.json                    Root workspace scripts
  pnpm-workspace.yaml             Workspace definition
  tsconfig.json                   Shared TypeScript config
  WEBSOCKET_PROTOCOL.md           Full PlexChat protocol specification

  packages/
    shared/src/
      config.ts                   Zod-validated env config loader
      umi.ts                      Umi factory (mode-aware signer setup)
      transaction.ts              submitOrSend() -- mode-aware tx routing + fee prepend
      execute.ts                  Tool execution wrapper with RequestContext
      auth.ts                     Owner resolution, auth policy, withAuth wrapper
      context.ts                  readAgentContext() -- shared AgentContext extractor
      error-codes.ts              Shared protocol / tool error-code constants
      server-limits.ts            Server-side limit helpers (content size, RPC budget, ...)
      jupiter.ts                  Jupiter API helpers (quote, swap, price, simulateAndVerifySwap)
      state.ts                    agent-state.json read/write
      types/protocol.ts           PlexChat message type definitions
      types/agent.ts              AgentContext and TransactionSender interfaces
      types/tool-result.ts        ToolResult<T> + ok()/info()/err() helpers
      index.ts                    Barrel exports

    core/src/
      create-agent.ts             Factory: returns public or autonomous agent
      agent-public.ts             Public mode Mastra Agent definition
      agent-autonomous.ts         Autonomous mode Mastra Agent definition
      prompts.ts                  System prompt (base + mode addendums)
      index.ts                    Package exports
      tools/
        index.ts                  Tool registry (mode-based assignment)
        shared/                   12 tools for both modes
        public/                   2 tools for public mode only

    server/src/
      index.ts                    Entry point (instantiates PlexChatServer)
      websocket.ts                PlexChatServer class (auth, routing, streaming)
      session.ts                  Per-connection Session (state, send, cleanup)

    ui/src/
      app/page.tsx                Main page (chat + wallet + tx approval)
      app/providers.tsx           Solana wallet adapter context
      app/env.ts                  Client-side WebSocket URL builder
      hooks/use-plexchat.ts       WebSocket hook (connect, messages, reconnect)
      hooks/use-debug-panel.ts    Debug telemetry tracking
      components/chat-panel.tsx   Message list + input
      components/chat-message.tsx Message bubble with markdown
      components/typing-indicator.tsx  Animated typing dots
      components/debug/           Debug panel (4 tabs: Steps, Context, Messages, Totals)
```
