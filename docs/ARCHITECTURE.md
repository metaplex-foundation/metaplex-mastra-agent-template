# Architecture & Reference

Deep-dive companion to the top-level [README](../README.md). The README is a 5-minute quickstart aimed at getting an agent running; this document covers the full architecture, agent modes, env-var catalog, tool authoring, and customization.

For other reference material:

- [`docs/SPEC.md`](./SPEC.md) — canonical product spec, intended to reconstruct equivalent code from scratch.
- [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) — per-mode deployment recipes (Railway, nginx, Docker, Kubernetes).
- [`WEBSOCKET_PROTOCOL.md`](../WEBSOCKET_PROTOCOL.md) — wire-level PlexChat protocol reference.
- [`docs/UI-SIWS-MIGRATION.md`](./UI-SIWS-MIGRATION.md) — chat-template repo migration guide for SIWS auth.

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
| **Chat UI useful?** | Yes — pair with [metaplex-agent-chat-template](https://github.com/metaplex-foundation/metaplex-agent-chat-template) | Usually no — autonomous agents don't need a chat frontend |
| **Deployment shape** | Long-lived WS server behind nginx/TLS, public ingress | Background worker, no public ingress, keypair in a secrets manager |

**Unsure? Pick `public` — it's the default and the built-in UI lets you see everything working in minutes.** You can switch later by editing one env var.

**Want to prune the template for a single-mode fork?** Run `pnpm bootstrap` and the script will delete the code paths, env vars, and packages that don't apply to your chosen mode.

See [Agent Modes](#agent-modes) below for the full architectural detail, and [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) for production recipes per mode.

---

## Architecture

```text
+-----------------------------------------------------+
|                     Frontend                         |
|    (metaplex.com, metaplex-agent-chat-template, or  |
|     any WS client with wallet support)              |
+---------------------------+--------------------------+
                            |
                      PlexChat Protocol
                     (WebSocket + JSON)
                            |
+---------------------------+--------------------------+
|                  @metaplex-foundation/server               |
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
| @metaplex-foundation/core|   | @metaplex-foundation/shared      |
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
5. Agent text response is sent back to the originating session (each WebSocket connection is isolated — see "Session Model" in [`WEBSOCKET_PROTOCOL.md`](../WEBSOCKET_PROTOCOL.md)).

---

## Agent Modes

The template supports two operating modes, controlled by the `AGENT_MODE` environment variable.

Both modes share the same unified identity (keypair + on-chain asset + PDA + optional token). The only difference is how transactions are **routed**: who signs and submits them. See [`docs/SPEC.md`](./SPEC.md) §3 and §4 for the full model.

### Public Mode (multi-user, user-signed txs)

```dotenv
AGENT_MODE=public
```

End users sign their own transactions in their browser wallet. The agent builds the transaction with the user's wallet as fee payer (via `createNoopSigner`), serializes it, and sends it over the WebSocket. The server prepends a configurable SOL fee (`AGENT_FEE_SOL`) payable to the agent's PDA once the agent is registered.

Each WebSocket connection is its own session (isolated wallet, conversation history, and pending transaction queue), so multiple concurrent users can share a single server instance safely.

**Use cases:** wallet cleanup bots, faucet agents, NFT minting assistants, token launch assistants, portfolio advisors.

**How it works:**
- `createUmi()` returns a Umi instance seeded with the agent keypair; it still signs server-side operations (registration, Jupiter swaps that go through the agent wallet), but user-facing transactions use a `NoopSigner` placeholder for the connected wallet.
- `submitOrSend()` builds the transaction, prepends the agent fee, serializes to base64, pushes it through the `TransactionSender`, and **awaits** the user's signature via a correlation-ID-keyed promise (see [`WEBSOCKET_PROTOCOL.md`](../WEBSOCKET_PROTOCOL.md)).
- The tool returns the real signature (or throws on rejection/timeout).

### Autonomous Mode (agent-signed txs, worker loop)

```dotenv
AGENT_MODE=autonomous
AGENT_KEYPAIR=<base58-encoded secret key>
BOOTSTRAP_WALLET=<base58 pubkey>   # required until the agent registers on-chain
TICK_INTERVAL_MS=300000            # default 5 min
AUTONOMOUS_DRY_RUN=true            # default true — flip to false in production
MAX_TICK_TX_COUNT=3                # default 3 — per-tick tx cap
```

In autonomous mode the agent runs on a **worker loop** — every `TICK_INTERVAL_MS` it wakes up, reads goals + tasks + recent journal from `agent-state.json`, and decides whether to act. The agent signs and submits transactions directly with its keypair.

The owner-gated WebSocket server **stays on** in autonomous mode and becomes the **configuration interface**: brief the agent through chat ("your goal is to DCA into MPLX"), inspect goals/tasks in the debug panel, pause via chat. No env-var prompt engineering, no redeploys to change strategy.

**Use cases:** treasury rebalancer, scheduled buybacks, DCA bot, watcher daemon — any agent that acts on a timer without a human in the loop.

**Safety defaults:**
- `AUTONOMOUS_DRY_RUN=true` is **on by default**. Transaction-submitting tools log "would have sent X" and return synthetic `DRYRUN_*` signatures instead of broadcasting. Flip to `false` once you've verified behavior end-to-end.
- `MAX_TICK_TX_COUNT` caps how many transactions the agent can submit in one tick. Resets each tick.
- Three consecutive failed ticks auto-pause the loop (`paused=true` in state, journal entry recorded). The owner unpauses via chat after fixing whatever broke.

**How it works:**
- `createUmi()` decodes `AGENT_KEYPAIR`, creates a signer, and sets it as the Umi identity and fee payer.
- `submitOrSend()` calls `builder.sendAndConfirm(umi)` and returns the base58 signature (or a `DRYRUN_*` stub if dry-run is on).
- The worker loop attaches a per-tick `TxCounter` to `requestContext`; `submitOrSend` enforces the cap before broadcasting.

See [`docs/plans/2026-05-03-autonomous-worker-loop-design.md`](./plans/2026-05-03-autonomous-worker-loop-design.md) for the full design.

---

## Environment Variables

All variables are loaded from `.env` at the workspace root and validated with Zod at startup. The table below groups them by whether they are required, optional-with-default, or optional-no-default. See [`docs/SPEC.md`](./SPEC.md) §8.1 for the canonical list.

### Required

| Variable | Description |
|---|---|
| `AGENT_KEYPAIR` | Base58-encoded secret key (or JSON byte array) for the agent wallet. Required in both modes -- the agent always has a keypair that signs registration, delegation, and treasury operations. |
| LLM API Key | One of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY`, matching the provider prefix in `LLM_MODEL`. |

### Optional (with defaults)

| Variable | Default | Description |
|---|---|---|
| `AGENT_MODE` | `public` | `"public"` or `"autonomous"` |
| `AGENT_AUTH_MODE` | auto-resolved | SIWS auth tier: `owner`, `allowlist`, or `open`. Auto-resolves to `owner` for autonomous, `allowlist` for public when `WALLET_ALLOWLIST` is set, otherwise `open`. |
| `AUTH_NONCE_TTL_MS` | `60000` | How long an issued SIWS nonce stays valid before the client must respond. |
| `AUTH_HANDSHAKE_TIMEOUT_MS` | `30000` | Hard timeout for the full handshake before the server closes the socket. |
| `WALLET_RATE_LIMIT_MAX` | `60` | Per-wallet sliding-window cap on post-auth chat messages. |
| `WALLET_RATE_LIMIT_WINDOW_MS` | `60000` | Sliding window length for the per-wallet limiter. |
| `WALLET_RATE_LIMIT_MAX_KEYS` | `10000` | LRU cap on tracked wallets in the per-wallet limiter. |
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
| `WS_ALLOWED_ORIGINS` | `http://localhost:3001,http://localhost:3000,https://metaplex.chat,https://www.metaplex.chat` | Comma-separated allowed `Origin` list for WS handshakes (CSWSH protection) |
| `MAX_MESSAGE_CONTENT` | `8000` | Per-message character cap on inbound chat `content` |
| `MAX_RPC_TIME_BUDGET_MS` | `60000` | Per-message cumulative RPC wall-clock budget before abort |
| `LOG_AUTH_FAILURES` | `true` | Emit `console.warn` on token mismatch, origin rejection, autonomous-gate denial, rate-limit breach |

### Optional (no default)

| Variable | Description |
|---|---|
| `WALLET_ALLOWLIST` | Comma-separated base58 pubkeys allowed to authenticate via SIWS. Conditional: required only when `AGENT_AUTH_MODE=allowlist` AND no `wallets.allowlist.json` file is present at `WALLET_ALLOWLIST_PATH` (the two sources are merged and deduped when both exist). Optional / ignored in `owner` and `open` tiers. The on-chain owner is always allowed regardless of this list. |
| `WALLET_ALLOWLIST_PATH` | Override the path of the allowlist file (default: `wallets.allowlist.json` at the workspace root). The file is hot-reloaded every 5s by mtime polling. |
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

### UI Environment

The chat UI lives in [metaplex-agent-chat-template](https://github.com/metaplex-foundation/metaplex-agent-chat-template). See its `.env.local.example` and README for `NEXT_PUBLIC_WS_*` and `NEXT_PUBLIC_SOLANA_*` configuration. The UI authenticates via the SIWS handshake using the connected browser wallet — there is no shared token to mirror. The only cross-repo contract is that the UI's `NEXT_PUBLIC_WS_HOST` points at the agent and the connecting wallet is allowed by the agent's `AGENT_AUTH_MODE` tier.

---

## Project Structure

```text
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
    core/                       # @metaplex-foundation/core
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

    server/                     # @metaplex-foundation/server
      src/
        index.ts                # Entry point -- creates and starts the server
        websocket.ts            # PlexChatServer class (auth, routing, streaming)
        session.ts              # Per-connection Session (state, send, cleanup)

    shared/                     # @metaplex-foundation/shared
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

```

The chat UI is a separate repo: [metaplex-agent-chat-template](https://github.com/metaplex-foundation/metaplex-agent-chat-template).

---

## Adding New Tools

Tools ship in the [`@metaplex-foundation/agent-tools`](../../metaplex-agent-toolkit/packages/tools) package (sibling repo `metaplex-agent-toolkit`). The template imports two named bundles —
`publicBundle` and `autonomousBundle` — and passes them straight to `new Agent({ tools })`. To select a different subset, build your own:

```ts
import { createToolset } from '@metaplex-foundation/agent-tools';

const tools = createToolset({
  include: ['get-balance', 'category:trade'],
  exclude: ['withdraw-sol'],
  capabilities: ['umi-rpc', 'agent-keypair', 'jupiter'],
});
```

`include` accepts tool ids, `'*'`, or `'category:<name>'`; `exclude` accepts the same shapes. `capabilities` declares what the host can fulfil — included tools whose `requires` isn't a subset throw at build time.

### Authoring a new tool (in the toolkit)

```ts
// metaplex-agent-toolkit/packages/tools/src/tools/get-account-info.ts
import { z } from 'zod';
import { publicKey } from '@metaplex-foundation/umi';
import { createUmi, ok, err, toToolError } from '@metaplex-foundation/agent-runtime';
import { defineTool } from '../define-tool.js';

export const getAccountInfo = defineTool({
  id: 'get-account-info',
  authLevel: 'public',
  category: 'read',
  requires: ['umi-rpc'],
  description: 'Get basic account info for a Solana address.',
  inputSchema: z.object({
    address: z.string().describe('Solana wallet address'),
  }),
  outputSchema: z.object({
    status: z.string().optional(),
    code: z.string().optional(),
    address: z.string().optional(),
    exists: z.boolean().optional(),
    lamports: z.string().optional(),
    owner: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async ({ address }) => {
    try {
      const umi = createUmi();
      const account = await umi.rpc.getAccount(publicKey(address));
      if (!account.exists) return ok({ address, exists: false });
      return ok({
        address,
        exists: true,
        lamports: account.lamports.basisPoints.toString(),
        owner: account.owner.toString(),
      });
    } catch (e) {
      const { code, message } = toToolError(e);
      return err(code, message);
    }
  },
});
```

`defineTool` registers the tool in the toolkit's in-memory registry as a side-effect of evaluation. Re-export it from `packages/tools/src/tools/index.ts` and the bundles + `createToolset` see it automatically.

### Authoring a one-off tool (in the template, without forking the toolkit)

If a tool is specific to a single fork and shouldn't live in the toolkit, call `defineTool` directly in the template and combine the result with a bundle:

```ts
import { defineTool, publicBundle } from '@metaplex-foundation/agent-tools';
import { z } from 'zod';
import { ok } from '@metaplex-foundation/agent-runtime';

const myCustomTool = defineTool({
  id: 'my-custom-thing',
  authLevel: 'public',
  category: 'utility',
  requires: [],
  description: 'Does the custom thing.',
  inputSchema: z.object({ x: z.string() }),
  outputSchema: z.object({ status: z.string().optional(), echo: z.string().optional() }),
  execute: async ({ x }) => ok({ echo: x }),
});

new Agent({
  // ...
  tools: { ...publicBundle, myCustomThing: myCustomTool },
});
```

### 3. Tools that write transactions

For tools that build and submit transactions, use the `submitOrSend` helper from `@metaplex-foundation/agent-runtime`. This function handles both agent modes automatically:

- **Public mode:** serializes the transaction to base64, pushes it to the connected client, and **awaits** the user's signature. Returns the confirmed signature (or throws on rejection/timeout).
- **Autonomous mode:** signs with the agent keypair and submits directly to the network. Returns the signature.

Either way, `submitOrSend` returns a real `Promise<string>` resolving to the base58 signature -- there is no longer a `'sent-to-wallet'` pending state to branch on.

See `metaplex-agent-toolkit/packages/tools/src/tools/transfer-sol.ts` for the full pattern. The key parts:

```typescript
import { submitOrSend, createUmi, readAgentContext, ok, err } from '@metaplex-foundation/agent-runtime';

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

    // Use the ok()/info()/err() helpers from @metaplex-foundation/agent-runtime for a
    // consistent ToolResult<T> shape the LLM can branch on (`status` field).
    return ok({ signature, message: `Done. Signature: ${signature}` });
  } catch (e) {
    return err('GENERIC', e instanceof Error ? e.message : String(e));
  }
};
```

See [`docs/SPEC.md`](./SPEC.md) Appendix B for the canonical `AgentContext` shape and §5.3 for the `ToolResult<T>` convention.

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
| `auth_response` | Complete the SIWS handshake (publicKey + signature + signed message) |
| `message` | Send a chat message to the agent (post-auth only) |
| `tx_result` | Report a signed and submitted transaction (requires `correlationId` + `signature`) |
| `tx_error` | Report a rejected or failed transaction (requires `correlationId`, optional `reason`) |

### Server-to-client messages

All server-to-client messages are unicast to the originating session — no cross-session broadcast.

| Type | Purpose |
|---|---|
| `connected` | Sent on successful WebSocket connection |
| `auth_challenge` | SIWS nonce + canonical-message metadata for the client to sign |
| `authenticated` | SIWS handshake succeeded; chat plane opens. Includes `walletAddress` and `isOwner`. |
| `auth_error` | SIWS handshake failed; followed by `ws.close(4001, code)` |
| `message` | Agent chat response |
| `typing` | Typing indicator on/off |
| `transaction` | Serialized Solana transaction for wallet signing (includes `correlationId`; includes `feeSol` in public mode when a fee is prepended) |
| `error` | Error response |

### Authentication

Connections authenticate via a Sign-In-With-Solana (SIWS) handshake. The client opens a plain WebSocket, receives an `auth_challenge` with a single-use nonce, signs the canonical message with the user's Solana wallet, and sends `auth_response`. The server verifies the Ed25519 signature and checks the wallet against the configured `AGENT_AUTH_MODE` tier (`owner` / `allowlist` / `open`). On success the wallet is bound to the session; on failure the connection is closed with code `4001`.

For the complete protocol specification — message schemas, the SIWS canonical message, error codes, multi-transaction flows, state management, and a worked example — see [WEBSOCKET_PROTOCOL.md](../WEBSOCKET_PROTOCOL.md).

---

## Development

All commands are run from the workspace root.

| Command | Description |
|---|---|
| `pnpm dev` | Build deps then start the server in watch mode |
| `pnpm dev:ui` | Start the test UI on http://localhost:3001 (assumes `metaplex-agent-chat-template` is cloned at the sibling path) |
| `pnpm dev:full` | Build deps then start both server and chat UI together (clones the chat-template sibling on first run) |
| `pnpm build` | Build all packages (`tsc` in each workspace) |
| `pnpm typecheck` | Run TypeScript type checking across all packages (no emit) |
| `pnpm clean` | Remove `dist/` / `.next/` directories from all packages |

The `dev` command builds `shared` and `core` first, then uses `tsx watch` to run `packages/server/src/index.ts` with hot reload. Changes to any package source file will trigger a restart.

### Building for production

```bash
pnpm build
pnpm --filter @metaplex-foundation/server start
```

This compiles TypeScript to JavaScript in each package's `dist/` folder, then starts the server from the compiled output.

---

## Deployment Notes

The repo ships three deploy artifacts out of the box:

- **`Dockerfile`** — multi-stage Node 20 slim image. Installs with pnpm, builds `shared → core → server`, and runs as non-root user `agent` on port 3002. UI is excluded from the server image via `.dockerignore` (the UI is designed to deploy separately, e.g. on Vercel).
- **`railway.json`** — Railway config pointing at the Dockerfile. Railway injects `PORT`; `config.ts` falls back to it when `WEB_CHANNEL_PORT` is not set, so no extra wiring is needed.
- **`.dockerignore`** — keeps `.env`, `agent-state.json`, `node_modules`, local builds, docs, and the UI source out of the build context.

For end-to-end recipes per mode (nginx examples, hardening checklists, Docker tuning, Kubernetes manifests) see [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md). A step-by-step **Railway** deploy lives in that file too — it's the fastest path from `git push` to a running public-mode agent.

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

The auth model is Sign-In-With-Solana (SIWS) — every WebSocket connection completes a wallet-signature handshake before any chat-plane traffic is accepted. There are three tiers, controlled by `AGENT_AUTH_MODE`:

| Tier | Default for | Allowed wallets |
|---|---|---|
| `owner` | autonomous mode | The on-chain agent asset owner only. |
| `allowlist` | public mode when `WALLET_ALLOWLIST` is set | Owner ∪ wallets in `wallets.allowlist.json` ∪ `WALLET_ALLOWLIST` env. |
| `open` | public mode when no allowlist is configured | Any wallet that completes a valid SIWS signature. |

The owner is **always** authorized regardless of tier.

For production:

- **Terminate TLS** (`wss://`) at a reverse proxy. The SIWS handshake itself is replay-protected, but transport encryption still matters for `auth_response` confidentiality and for protecting chat content.
- **Pick the tightest tier that fits.** `owner` for headless autonomous deployments; `allowlist` for invite-only public deployments; `open` only for genuinely public agents (and rely on per-wallet rate limits + LLM cost budgets).
- **Populate the allowlist via either source.** `wallets.allowlist.json` at the workspace root (hot-reloaded every 5s, gitignored) is the primary mechanism; `WALLET_ALLOWLIST=pk1,pk2,...` is the env-var fallback for cloud deploys without writable filesystems. The two are merged and deduped if both are present.
- **Constrain `WS_ALLOWED_ORIGINS`** to exactly the origins allowed to open a WebSocket. Cross-site requests are rejected during the handshake.
- The server applies a per-wallet sliding-window rate limit on chat messages (`WALLET_RATE_LIMIT_MAX` / `WALLET_RATE_LIMIT_WINDOW_MS`) in addition to the per-session limiter; put an application-layer gateway (Cloudflare, nginx limits, etc.) in front to also cap handshake attempts by IP.

See [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) § "Auth tiers" for production recipes per tier and [`WEBSOCKET_PROTOCOL.md`](../WEBSOCKET_PROTOCOL.md) § Authentication for the wire-level handshake.

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

See [LICENSE](../LICENSE) for details.
