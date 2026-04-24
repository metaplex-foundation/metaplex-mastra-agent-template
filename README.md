# Metaplex Agent Template

A pnpm monorepo template for building AI agents that integrate with the [Metaplex Agent Registry](https://agents.metaplex.com). Uses [Mastra](https://mastra.ai) as the agent framework, [Metaplex Umi](https://github.com/metaplex-foundation/umi) as the Solana toolkit, and the PlexChat WebSocket protocol for real-time frontend communication.

Out of the box you get a working Solana agent with balance queries, SOL/token transfers, and transaction lookups -- ready to extend with your own tools.

---

## Which mode am I?

This template supports two operating modes. Pick one before you go further — almost every decision downstream flows from it.

| | **Public mode** | **Autonomous mode** |
|---|---|---|
| **Who signs transactions** | End users (browser wallet) | The agent (its own keypair) |
| **Typical shape** | Multi-user chatbot behind a UI | Headless daemon / cron / trading bot |
| **You want this if** | Users interact via chat and approve each tx in Phantom / Solflare | The agent runs on its own schedule and nobody is in the loop |
| **Example products** | Wallet cleanup bot, mint helper, token launch assistant, portfolio advisor | Treasury rebalancer, strategy bot, automated buybacks, scheduled payouts |
| **`.env` setting** | `AGENT_MODE=public` | `AGENT_MODE=autonomous` + `BOOTSTRAP_WALLET=<pubkey>` |
| **UI package useful?** | Yes — drop-in chat interface | Usually no — consider deleting `packages/ui/` |
| **Deployment shape** | Long-lived WS server behind nginx/TLS, public ingress | Background worker, no public ingress, keypair in a secrets manager |

**Unsure? Pick `public` — it's the default and the built-in UI lets you see everything working in minutes.** You can switch later by editing one env var.

**Want to prune the template for a single-mode fork?** Run `pnpm bootstrap` and the script will delete the code paths, env vars, and packages that don't apply to your chosen mode.

See [Agent Modes](#agent-modes) below for the full architectural detail, and [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) for production recipes per mode.

---

## Architecture

```
+-----------------------------------------------------+
|                     Frontend                         |
|    (metaplex.com, @metaplex-agent/ui, or any WS      |
|     client with wallet support)                      |
+---------------------------+--------------------------+
                            |
                      PlexChat Protocol
                     (WebSocket + JSON)
                            |
+---------------------------+--------------------------+
|                  @metaplex-agent/server               |
|                                                       |
|  - Authenticates WebSocket connections                |
|  - Manages per-session wallet state                   |
|  - Routes messages to the Mastra agent                |
|  - Sends responses, typing indicators, and            |
|    transactions back to the originating session       |
+---------+----------------------------+---------------+
          |                            |
          v                            v
+---------+----------+   +------------+---------------+
| @metaplex-agent/core|   | @metaplex-agent/shared      |
|                     |   |                              |
| - Mastra Agent def  |   | - PlexChat protocol types    |
| - System prompt     |   | - Env config (Zod-validated) |
| - Tool registry     |   | - Umi factory (RPC + signer) |
| - Solana tools      |   | - submitOrSend() helper      |
+---------------------+   | - AgentContext types          |
                           +------------------------------+
```

**Data flow for a chat message:**

1. Frontend sends `{ type: "message", content: "..." }` over WebSocket.
2. `server` authenticates, sets typing indicator, invokes the Mastra agent.
3. Agent selects and runs tools from `core` (which use `shared` for Umi and transactions).
4. In **public mode**, transactions are serialized and pushed back over the WebSocket for the user to sign. In **autonomous mode**, the agent signs and submits directly.
5. Agent text response is sent back to the originating session (each WebSocket connection is isolated — see "Session Model" in [`WEBSOCKET_PROTOCOL.md`](./WEBSOCKET_PROTOCOL.md)).

---

## Quick Start

### Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9
- An API key for your chosen LLM provider (Anthropic, OpenAI, or Google)

### 1. Clone and install

```bash
git clone <your-repo-url> my-agent
cd my-agent
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in the required values:

```dotenv
AGENT_MODE=public
LLM_MODEL=anthropic/claude-sonnet-4-5-20250929
ANTHROPIC_API_KEY=sk-ant-...
SOLANA_RPC_URL=https://api.devnet.solana.com
AGENT_KEYPAIR=<base58-encoded secret key or JSON byte array>
WEB_CHANNEL_TOKEN=<generate with: openssl rand -hex 24>
```

`AGENT_KEYPAIR` is required in **both** modes — the agent always needs a keypair to sign registration, delegation, and treasury operations. Generate one with:

```bash
solana-keygen new --no-bip39-passphrase --outfile /dev/stdout
```

### 3. Run in development

```bash
pnpm dev
```

The WebSocket server starts on `ws://localhost:3002` (or the port you configured).

### 4. Test with the built-in UI

The repo includes a lightweight Next.js chat UI for testing without the full metaplex.com frontend:

```bash
# Set up the UI env (token must match WEB_CHANNEL_TOKEN in .env)
cp packages/ui/.env.local.example packages/ui/.env.local
# Edit packages/ui/.env.local with your token

# Run both server and UI together
pnpm dev:all
```

Open http://localhost:3001 to chat with the agent, connect a Solana wallet (Phantom/Solflare), and test transaction signing.

You can also connect with any WebSocket client:

```bash
npx wscat -c 'ws://localhost:3002/?token=YOUR_TOKEN_HERE'
```

Send a test message:

```json
{"type":"message","content":"What is my SOL balance?","sender_name":"dev"}
```

---

## Agent Modes

The template supports two operating modes, controlled by the `AGENT_MODE` environment variable.

Both modes share the same unified identity (keypair + on-chain asset + PDA + optional token). The only difference is how transactions are **routed**: who signs and submits them. See [`docs/SPEC.md`](./docs/SPEC.md) §3 and §4 for the full model.

### Public Mode (multi-user, user-signed txs)

```
AGENT_MODE=public
```

End users sign their own transactions in their browser wallet. The agent builds the transaction with the user's wallet as fee payer (via `createNoopSigner`), serializes it, and sends it over the WebSocket. The server prepends a configurable SOL fee (`AGENT_FEE_SOL`) payable to the agent's PDA once the agent is registered.

Each WebSocket connection is its own session (isolated wallet, conversation history, and pending transaction queue), so multiple concurrent users can share a single server instance safely.

**Use cases:** wallet cleanup bots, faucet agents, NFT minting assistants, token launch assistants, portfolio advisors.

**How it works:**
- `createUmi()` returns a Umi instance seeded with the agent keypair; it still signs server-side operations (registration, Jupiter swaps that go through the agent wallet), but user-facing transactions use a `NoopSigner` placeholder for the connected wallet.
- `submitOrSend()` builds the transaction, prepends the agent fee, serializes to base64, pushes it through the `TransactionSender`, and **awaits** the user's signature via a correlation-ID-keyed promise (see [`WEBSOCKET_PROTOCOL.md`](./WEBSOCKET_PROTOCOL.md)).
- The tool returns the real signature (or throws on rejection/timeout).

### Autonomous Mode (agent-signed txs)

```
AGENT_MODE=autonomous
AGENT_KEYPAIR=<base58-encoded secret key>
BOOTSTRAP_WALLET=<base58 pubkey>   # required until the agent registers on-chain
```

The agent signs and submits transactions directly with its keypair. Only the on-chain asset owner (or `BOOTSTRAP_WALLET` bootstrap fallback) is allowed to interact — non-owner WebSocket connections are rejected at the connection gate before the LLM is ever invoked.

**Use cases:** portfolio rebalancer, trading bot, automated treasury manager, any agent that acts independently.

**How it works:**
- `createUmi()` decodes `AGENT_KEYPAIR`, creates a signer, and sets it as the Umi identity and fee payer.
- `submitOrSend()` calls `builder.sendAndConfirm(umi)` and returns the base58 signature.

---

## Environment Variables

All variables are loaded from `.env` at the workspace root and validated with Zod at startup. The table below groups them by whether they are required, optional-with-default, or optional-no-default. See [`docs/SPEC.md`](./docs/SPEC.md) §8.1 for the canonical list.

### Required

| Variable | Description |
|---|---|
| `AGENT_KEYPAIR` | Base58-encoded secret key (or JSON byte array) for the agent wallet. Required in both modes -- the agent always has a keypair that signs registration, delegation, and treasury operations. |
| `WEB_CHANNEL_TOKEN` | Shared secret for WebSocket authentication. **Must be at least 32 characters.** Generate with `openssl rand -hex 24` (48 hex chars) or `openssl rand -hex 32` (64 hex chars). |
| LLM API Key | One of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY`, matching the provider prefix in `LLM_MODEL`. |

### Optional (with defaults)

| Variable | Default | Description |
|---|---|---|
| `AGENT_MODE` | `public` | `"public"` or `"autonomous"` |
| `LLM_MODEL` | `anthropic/claude-sonnet-4-5-20250929` | Mastra model identifier (`provider/model-id`) |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Solana JSON-RPC endpoint |
| `WEB_CHANNEL_PORT` | `3002` | WebSocket server port |
| `ASSISTANT_NAME` | `Agent` | Display name in chat responses |
| `AGENT_FEE_SOL` | `0.001` | SOL fee prepended to each user tx (public mode only) |
| `MAX_STEPS` | `10` | Max LLM + tool steps per user message |
| `MAX_CONNECTIONS` | `10` | Max concurrent WebSocket sessions |
| `ENABLE_DEBUG_EVENTS` | `true` | Stream `debug:*` telemetry events |
| `MAX_SLIPPAGE_BPS` | `500` | Upper cap on `slippageBps` for swap tools |
| `MAX_PRICE_IMPACT_PCT` | `2.0` | Upper cap on Jupiter `priceImpactPct` |
| `OWNER_CACHE_TTL_MS` | `300000` | TTL for cached on-chain owner lookups |
| `WS_ALLOWED_ORIGINS` | `http://localhost:3001,http://localhost:3000` | Comma-separated allowed `Origin` list for WS handshakes (CSWSH protection) |
| `MAX_MESSAGE_CONTENT` | `8000` | Per-message character cap on inbound chat `content` |
| `MAX_RPC_TIME_BUDGET_MS` | `60000` | Per-message cumulative RPC wall-clock budget before abort |
| `LOG_AUTH_FAILURES` | `true` | Emit `console.warn` on token mismatch, origin rejection, autonomous-gate denial, rate-limit breach |

### Optional (no default)

| Variable | Description |
|---|---|
| `BOOTSTRAP_WALLET` | Base58 pubkey of the wallet allowed to bootstrap the agent. Required for autonomous mode pre-registration (server refuses to start without it). Once the agent is registered on-chain, the asset owner takes precedence and this value is no longer consulted. |
| `AGENT_ASSET_ADDRESS` | Operator override for registry address (auto-persisted to `agent-state.json` otherwise) |
| `AGENT_TOKEN_MINT` | Operator override for token mint (auto-persisted otherwise) |
| `TOKEN_OVERRIDE` | Target a specific token for buybacks (e.g. MPLX mint) instead of launching |
| `JUPITER_API_KEY` | Jupiter API key for price data and swap quotes |
| `AGENT_FUNDING_SOL` | Override SOL amount sent to the agent wallet during `register-agent` funding (default `0.02`) |
| `AGENT_FUNDING_THRESHOLD_SOL` | Balance threshold that triggers the funding flow (default `0.01`) |
| `MAX_TOKENS_PER_MESSAGE` | Cumulative LLM token cap per user message across all steps (default `100000`). Exceeding it aborts the turn with `BUDGET_EXCEEDED`. |
| `MAX_TOOL_EXECUTIONS_PER_MESSAGE` | Maximum tool calls per user message across all steps (default `30`). Exceeding it aborts the turn with `BUDGET_EXCEEDED`. |
| `PORT` | Fallback for `WEB_CHANNEL_PORT` when the platform (Railway/Render/Fly/Heroku) injects `PORT` instead. |

**LLM_MODEL format:** `<provider>/<model-id>`, using Mastra's model router. Examples:

- `anthropic/claude-sonnet-4-5-20250929`
- `openai/gpt-4o`
- `google/gemini-2.5-pro`

Set the corresponding API key environment variable for whichever provider you choose.

### UI Environment (packages/ui/.env.local)

| Variable | Default | Description |
|---|---|---|
| `NEXT_PUBLIC_WS_HOST` | `localhost` | WebSocket server host |
| `NEXT_PUBLIC_WS_PORT` | `3002` (local), `443` (remote) | WebSocket server port. Omitted from the URL when it matches the default port for the selected protocol. |
| `NEXT_PUBLIC_WS_PROTOCOL` | auto | Force `ws` or `wss`. When unset: `ws` for localhost/127.0.0.1, `wss` otherwise (avoids mixed-content blocking from HTTPS pages). |
| `NEXT_PUBLIC_WS_TOKEN` | -- | Must match `WEB_CHANNEL_TOKEN` (≥ 32 chars). Passed via the `bearer` subprotocol, not the URL. |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Solana RPC for wallet adapter |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | `devnet` | Cluster used for Solana Explorer links. One of `mainnet-beta`, `devnet`, `testnet`. |

---

## Project Structure

```
metaplex-agent-template/
  .env.example                  # Environment variable reference (grouped by mode)
  .dockerignore                 # Docker build-context exclusions
  .npmrc                        # shamefully-hoist=true (Umi compatibility)
  agent-state.json              # Auto-generated agent identity (0600, gitignored)
  Dockerfile                    # Multi-stage server image (Node 20 slim, non-root)
  package.json                  # Root workspace scripts (dev, build, typecheck, bootstrap)
  pnpm-workspace.yaml           # pnpm workspace definition (packages/*)
  railway.json                  # Railway deploy manifest (Dockerfile builder)
  tsconfig.json                 # Shared TypeScript config (ES2022, strict)
  WEBSOCKET_PROTOCOL.md         # Full PlexChat protocol specification
  docs/
    SPEC.md                     # Product requirements / canonical spec
    DEPLOYMENT.md               # Per-mode deployment recipes (nginx, Docker, Railway)
  scripts/
    bootstrap.ts                # Template pruner -- pnpm bootstrap [public|autonomous]

  packages/
    core/                       # @metaplex-agent/core
      src/
        create-agent.ts         # Factory: returns public or autonomous agent
        agent-public.ts         # Public-mode Mastra Agent definition
        agent-autonomous.ts     # Autonomous-mode Mastra Agent definition
        prompts.ts              # Shared base prompt + mode-specific addendums
        index.ts                # Package exports
        tools/
          index.ts              # Tool registry -- mode-based assignment
          shared/               # 12 tools available in both modes
            get-balance.ts        # SOL balance for any address
            get-token-balances.ts # All SPL holdings for an address
            get-transaction.ts    # Transaction status lookup
            get-token-price.ts    # Jupiter USD price for any token
            get-token-metadata.ts # Token name/symbol/image via DAS
            sleep.ts              # Pause 1-300 seconds (polling loops)
            register-agent.ts     # Mint agent asset on the Agent Registry
            delegate-execution.ts # Set up executive signing authority
            launch-token.ts       # Launch token via Metaplex Genesis
            swap-token.ts         # Jupiter DEX swap
            buyback-token.ts      # Buy the agent's own token (SOL -> token)
            sell-token.ts         # Sell the agent's own token (token -> SOL)
          public/               # 2 tools only for public mode
            transfer-sol.ts       # Transfer SOL from user wallet
            transfer-token.ts     # Transfer SPL tokens from user wallet

    server/                     # @metaplex-agent/server
      src/
        index.ts                # Entry point -- creates and starts the server
        websocket.ts            # PlexChatServer class (auth, routing, streaming)
        session.ts              # Per-connection Session (state, send, cleanup)

    shared/                     # @metaplex-agent/shared
      src/
        config.ts               # Zod-validated env config loader + AGENT_KEYPAIR decoder
        umi.ts                  # createUmi() -- Umi factory with keypair identity
        transaction.ts          # submitOrSend() -- mode-aware tx routing + fee prepend
        funding.ts              # ensureAgentFunded() -- mode-aware top-up seam
        execute.ts              # executeAsAgent() + getAgentPda() (MPL Core Execute CPI)
        auth.ts                 # Owner resolution, auth policy, withAuth wrapper
        context.ts              # readAgentContext() -- shared AgentContext extractor
        error-codes.ts          # toToolError() classifier + ToolErrorCodes
        server-limits.ts        # getServerLimits() -- funding + per-message budgets
        jupiter.ts              # Quote/swap/price helpers + simulateAndVerifySwap
        state.ts                # agent-state.json atomic read/write
        index.ts                # Barrel exports
        types/
          protocol.ts           # PlexChat WebSocket message type definitions
          agent.ts              # AgentContext and TransactionSender interfaces
          tool-result.ts        # ToolResult<T> + ok()/info()/err() helpers

    ui/                         # @metaplex-agent/ui
      src/
        app/
          page.tsx              # Main page -- chat + wallet + transaction approval
          providers.tsx         # Solana wallet adapter context providers
          env.ts                # Client-side WebSocket URL builder
        hooks/
          use-plexchat.ts       # WebSocket hook (connect, messages, typing, reconnect)
          use-debug-panel.ts    # Debug telemetry tracking
        components/
          chat-panel.tsx        # Scrollable message list + input
          chat-message.tsx      # Single message bubble
          typing-indicator.tsx  # Animated typing dots
          transaction-approval.tsx  # Sign + send transaction overlay
          debug/                    # Debug panel (Steps, Context, Messages, Totals)
```

---

## Adding New Tools

Tools live under `packages/core/src/tools/` in one of two subdirectories:

- **`shared/`** -- available in both public and autonomous modes (12 tools ship in this directory)
- **`public/`** -- only registered in public mode (`transfer-sol`, `transfer-token`)

Pick the one that matches your tool's scope.

### 1. Create the tool file

Here is an example read-only tool placed in `shared/`:

```typescript
// packages/core/src/tools/shared/get-account-info.ts

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-agent/shared';

export const getAccountInfo = createTool({
  id: 'get-account-info',
  description: 'Get basic account info for a Solana address.',
  inputSchema: z.object({
    address: z.string().describe('Solana wallet address'),
  }),
  outputSchema: z.object({
    address: z.string(),
    exists: z.boolean(),
    lamports: z.string().optional(),
    owner: z.string().optional(),
  }),
  execute: async ({ address }) => {
    const umi = createUmi();
    const account = await umi.rpc.getAccount(publicKey(address));

    if (!account.exists) {
      return { address, exists: false };
    }

    return {
      address,
      exists: true,
      lamports: account.lamports.basisPoints.toString(),
      owner: account.owner.toString(),
    };
  },
});
```

### 2. Register the tool

Add the import and entry to `packages/core/src/tools/shared/index.ts` (or `public/index.ts` for public-only tools):

```typescript
// packages/core/src/tools/shared/index.ts
import { getBalance } from './get-balance.js';
import { getTokenBalances } from './get-token-balances.js';
import { getTransaction } from './get-transaction.js';
// ...existing imports...
import { getAccountInfo } from './get-account-info.js';  // <-- add import

export const sharedTools = {
  getBalance,
  getTokenBalances,
  getTransaction,
  // ...existing tools...
  getAccountInfo,  // <-- add to registry
};
```

That is all that is needed. Mastra automatically exposes registered tools to the LLM. The top-level `tools/index.ts` composes `sharedTools` + `publicTools` (public mode) or just `sharedTools` (autonomous mode).

### 3. Tools that write transactions

For tools that build and submit transactions, use the `submitOrSend` helper from `@metaplex-agent/shared`. This function handles both agent modes automatically:

- **Public mode:** serializes the transaction to base64, pushes it to the connected client, and **awaits** the user's signature. Returns the confirmed signature (or throws on rejection/timeout).
- **Autonomous mode:** signs with the agent keypair and submits directly to the network. Returns the signature.

Either way, `submitOrSend` returns a real `Promise<string>` resolving to the base58 signature -- there is no longer a `'sent-to-wallet'` pending state to branch on.

See `packages/core/src/tools/public/transfer-sol.ts` for the full pattern. The key parts:

```typescript
import { submitOrSend, createUmi, readAgentContext, ok, err } from '@metaplex-agent/shared';

// Inside your tool's execute function:
execute: async ({ destination, amount }, { requestContext }) => {
  // Extract the full AgentContext from RequestContext (handles defaults for you).
  const context = readAgentContext(requestContext);

  const umi = createUmi();

  // Build the transaction using Umi / mpl-toolbox
  const builder = transferSolIx(umi, { /* ... */ });

  try {
    // Submit or send -- handles both modes, returns the signature
    const signature = await submitOrSend(umi, builder, context, {
      message: `Transfer ${amount} SOL to ${destination}`,
    });

    // Use the ok()/info()/err() helpers from @metaplex-agent/shared for a
    // consistent ToolResult<T> shape the LLM can branch on (`status` field).
    return ok({ signature, message: `Done. Signature: ${signature}` });
  } catch (e) {
    return err('GENERIC', e instanceof Error ? e.message : String(e));
  }
};
```

See [`docs/SPEC.md`](./docs/SPEC.md) Appendix B for the canonical `AgentContext` shape and §5.2 for the `ToolResult<T>` convention.

---

## Customizing the Agent

### Changing the system prompt

The system prompt lives in `packages/core/src/prompts.ts`. It exports a shared base prompt plus a per-mode addendum, composed at agent creation time via `buildSystemPrompt(mode)`. Edit the base constant to change the agent's personality or domain focus:

```typescript
// packages/core/src/prompts.ts
export const BASE_SYSTEM_PROMPT = `You are a DeFi portfolio assistant on Solana.
You help users track their holdings, suggest rebalancing strategies,
and execute swaps when asked. Always explain risks before executing trades.`;
```

Update the mode addendums (also in `prompts.ts`) when you want public- or autonomous-specific guidance.

### Switching LLM providers

Change `LLM_MODEL` in your `.env` file and set the matching API key:

```dotenv
# Switch to OpenAI
LLM_MODEL=openai/gpt-4o
OPENAI_API_KEY=sk-...

# Or switch to Google
LLM_MODEL=google/gemini-2.5-pro
GOOGLE_GENERATIVE_AI_API_KEY=...
```

No code changes are needed. The `createAgent()` function reads `LLM_MODEL` from the config and passes it directly to Mastra's `Agent` constructor, which routes to the correct provider.

### Changing the agent name

Set `ASSISTANT_NAME` in your `.env` file. This controls the `sender` field in chat responses:

```dotenv
ASSISTANT_NAME=SolBot
```

---

## PlexChat Protocol

The WebSocket server implements the **PlexChat** protocol for bidirectional communication between frontends and the agent.

### Client-to-server messages

| Type | Purpose |
|---|---|
| `message` | Send a chat message to the agent |
| `wallet_connect` | Notify the server of a connected Solana wallet address |
| `wallet_disconnect` | Clear the connected wallet |
| `tx_result` | Report a signed and submitted transaction (requires `correlationId` + `signature`) |
| `tx_error` | Report a rejected or failed transaction (requires `correlationId`, optional `reason`) |

### Server-to-client messages

All server-to-client messages are unicast to the originating session — no cross-session broadcast.

| Type | Purpose |
|---|---|
| `connected` | Sent on successful WebSocket connection |
| `message` | Agent chat response |
| `typing` | Typing indicator on/off |
| `transaction` | Serialized Solana transaction for wallet signing (includes `correlationId`; includes `feeSol` in public mode when a fee is prepended) |
| `wallet_connected` | Wallet connection confirmed |
| `wallet_disconnected` | Wallet disconnection confirmed |
| `error` | Error response |

### Authentication

Connections require a token via query parameter (`?token=...`) or `Authorization: Bearer ...` header. Unauthorized connections are closed with code `4001`.

For the complete protocol specification including message schemas, multi-transaction flows, state management, and example code, see [WEBSOCKET_PROTOCOL.md](./WEBSOCKET_PROTOCOL.md).

---

## Development

All commands are run from the workspace root.

| Command | Description |
|---|---|
| `pnpm dev` | Build deps then start the server in watch mode |
| `pnpm dev:ui` | Start the test UI on http://localhost:3001 |
| `pnpm dev:all` | Build deps then start both server and test UI |
| `pnpm build` | Build all packages (`tsc` in each workspace) |
| `pnpm typecheck` | Run TypeScript type checking across all packages (no emit) |
| `pnpm clean` | Remove `dist/` / `.next/` directories from all packages |

The `dev` command builds `shared` and `core` first, then uses `tsx watch` to run `packages/server/src/index.ts` with hot reload. Changes to any package source file will trigger a restart.

### Building for production

```bash
pnpm build
pnpm --filter @metaplex-agent/server start
```

This compiles TypeScript to JavaScript in each package's `dist/` folder, then starts the server from the compiled output.

---

## Deployment Notes

The repo ships three deploy artifacts out of the box:

- **`Dockerfile`** — multi-stage Node 20 slim image. Installs with pnpm, builds `shared → core → server`, and runs as non-root user `agent` on port 3002. UI is excluded from the server image via `.dockerignore` (the UI is designed to deploy separately, e.g. on Vercel).
- **`railway.json`** — Railway config pointing at the Dockerfile. Railway injects `PORT`; `config.ts` falls back to it when `WEB_CHANNEL_PORT` is not set, so no extra wiring is needed.
- **`.dockerignore`** — keeps `.env`, `agent-state.json`, `node_modules`, local builds, docs, and the UI source out of the build context.

For end-to-end recipes per mode (nginx examples, hardening checklists, Docker tuning, Kubernetes manifests) see [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md). A step-by-step **Railway** deploy lives in that file too — it's the fastest path from `git push` to a running public-mode agent.

### Use WSS in production

The WebSocket server runs unencrypted (`ws://`) by default. In production, terminate TLS at a reverse proxy:

```nginx
# nginx example
location /ws {
    proxy_pass http://127.0.0.1:3002;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

### Authentication

The current auth model is a single shared token (`WEB_CHANNEL_TOKEN`, minimum 32 chars). For production:

- **Prefer subprotocol or Authorization-header auth** over the query param. Browser clients should open the WebSocket with `new WebSocket(url, ['bearer', token])` so the token travels in the handshake and never appears in reverse-proxy access logs, browser history, or Referer headers. See [`WEBSOCKET_PROTOCOL.md`](./WEBSOCKET_PROTOCOL.md) § Authentication.
- **Terminate TLS** (`wss://`) at a reverse proxy -- the handshake, including the subprotocol header, is only encrypted on the wire if the transport is encrypted.
- **Use tokens ≥ 32 characters** (preferably a per-user JWT or session cookie tied to your app's auth system, not a single shared secret for all clients).
- **Constrain `WS_ALLOWED_ORIGINS`** to exactly the origins allowed to open a WebSocket. Cross-site requests are rejected during the handshake.
- The server applies per-session rate limits internally; put an application-layer gateway (Cloudflare, nginx limits, etc.) in front to also cap handshake attempts by IP.

### RPC endpoint

The default `https://api.devnet.solana.com` is rate-limited and intended for development only. For production:
- Use a dedicated RPC provider (Helius, QuickNode, Triton, etc.)
- Set `SOLANA_RPC_URL` to your provider's endpoint
- Switch to mainnet-beta when ready

### Agent keypair security (autonomous mode)

If running in autonomous mode, the `AGENT_KEYPAIR` environment variable contains a secret key with direct access to funds. Store it securely:
- Use a secrets manager (AWS Secrets Manager, Vault, etc.)
- Never commit it to version control
- Restrict file permissions on `.env` in production
- Fund the agent wallet with only what it needs

---

## License

See [LICENSE](./LICENSE) for details.
