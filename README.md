# Metaplex Agent Template

> Build and launch a Solana AI agent in five minutes. SIWS wallet auth, on-chain identity via the [Metaplex Agent Registry](https://metaplex.com/agents), Mastra + Umi inside, no shared secrets to manage.
>
> **BYOK-free mode:** point `PLUMBER_URL` at a running [agent-plumber](../agent-plumber) and the template runs without provider API keys or a paid Solana RPC. Plumber handles LLM inference, image generation, Solana RPC, and DAS; the agent pays per-call in SOL via x402. See [Plumber-backed mode](#plumber-backed-mode) below.

[![Agent Registry](https://img.shields.io/badge/Metaplex%20Agent%20Registry-7c3aed)](https://metaplex.com/agents)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https%3A%2F%2Fgithub.com%2Fmetaplex-foundation%2Fmetaplex-mastra-agent-template&envs=AGENT_MODE,AGENT_KEYPAIR,WALLET_ALLOWLIST,SOLANA_RPC_URL,ANTHROPIC_API_KEY)

Browse registered agents at [metaplex.com/agents](https://metaplex.com/agents). Once you deploy and register your own, it shows up there too.

---

## Quick start (5 minutes)

### Prerequisites

- **Node.js** ≥ 22 (the coverage script uses `fs.promises.glob`, which landed in Node 22; the test reporter pairing for `lcov` also stabilized in 22)
- **pnpm** ≥ 9
- **EITHER** a `PLUMBER_URL` pointing at a running agent-plumber instance (BYOK-free, default) **OR** an API key for one LLM provider (Anthropic / OpenAI / Google) plus a Solana RPC URL
- A Solana wallet you can sign with (Phantom, Solflare, or any wallet adapter that supports `signMessage`)

> **Node 20 users:** the runtime targets >= 20, but the dev tooling (specifically `scripts/check-coverage.ts`) needs >= 22. If you must stay on 20, either run that script under a separate Node 22 install or swap `fs.promises.glob` for the [`glob`](https://www.npmjs.com/package/glob) npm package.

### 1. Clone & install

```bash
git clone https://github.com/metaplex-foundation/metaplex-mastra-agent-template.git my-agent
cd my-agent
pnpm install
```

### 2. Configure

Two paths — pick one:

**Interactive (recommended).** Generates a fresh `AGENT_KEYPAIR`, prompts for your LLM key and wallet pubkey, writes `.env` + `wallets.allowlist.json`:

```bash
pnpm setup
```

**Manual.** Copy the example file and edit four values:

```bash
cp .env.example .env
$EDITOR .env   # fill AGENT_KEYPAIR, ANTHROPIC_API_KEY, WALLET_ALLOWLIST
```

Either way, `pnpm doctor` validates the config + RPC reachability + LLM key + keypair balance:

```bash
pnpm doctor
```

### 3. Run

Server + chat UI together (clones the chat-template sibling repo on first run if needed):

```bash
pnpm dev:full
```

Or run them separately:

```bash
pnpm dev          # WebSocket server only on ws://localhost:3002
pnpm dev:ui       # chat UI only on http://localhost:3001
```

Open <http://localhost:3001>, connect your wallet, sign the SIWS prompt, and chat.

---

## Deploy

### One-click Railway

Click the **Deploy on Railway** button at the top. Railway prompts for the five env vars (`AGENT_MODE`, `AGENT_KEYPAIR`, `WALLET_ALLOWLIST`, `SOLANA_RPC_URL`, an LLM key) and gives you a `wss://` URL. Paste that URL into the hosted chat UI's profile, sign in with your wallet, and you're running in production.

> **Important on Railway:** the container filesystem is ephemeral, so `agent-state.json` is wiped on every redeploy. After the first run, copy `AGENT_ASSET_ADDRESS` from the logs into the service's env vars to skip re-registration on future deploys. (See [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) for the full Railway recipe.)

### Other targets

`Dockerfile`, `railway.json`, and the per-mode hardening checklists live in [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md). The template ships ready for Fly, Render, Koyeb, plain Docker, or Kubernetes.

---

## What you can build

The tools (balances, prices, swaps, registration, treasury, autonomous goals/tasks, transfers) ship as [`@metaplex-foundation/agent-tools`](https://www.npmjs.com/package/@metaplex-foundation/agent-tools) on npm. This template wires up the `publicBundle` / `autonomousBundle` by default; cherry-pick with `createToolset({ include, exclude, capabilities })` if you only need a subset. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#adding-new-tools).

Two operating modes, picked via `AGENT_MODE`:

| Mode | Who signs txs | Use case |
|---|---|---|
| `public` (default) | End user's browser wallet | Chatbots, mint helpers, portfolio advisors, faucet agents |
| `autonomous` | The agent's own keypair | Treasury rebalancers, DCA bots, scheduled buybacks, watcher daemons |

Pick `public` if unsure — switching is one env var. The full architectural detail is in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

---

## Reference

- **[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)** — full architecture, agent modes, env-var catalog, tool authoring, customization
- **[`docs/SPEC.md`](./docs/SPEC.md)** — canonical product spec
- **[`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md)** — production deploy recipes per mode
- **[`WEBSOCKET_PROTOCOL.md`](./WEBSOCKET_PROTOCOL.md)** — wire-level PlexChat protocol
- **[`docs/UI-SIWS-MIGRATION.md`](./docs/UI-SIWS-MIGRATION.md)** — chat-template repo migration guide for SIWS auth
- **[`.env.advanced.example`](./.env.advanced.example)** — full env-var catalog (rate limits, RPC budgets, autonomous-mode worker knobs)

---

## Common scripts

| Command | Purpose |
|---|---|
| `pnpm setup` | Interactive scaffolder — fills `.env` + generates keypair + seeds allowlist |
| `pnpm doctor` | Validates `.env`, RPC, LLM key, keypair balance, runs SIWS smoke if server is up |
| `pnpm dev` | Build deps then start the server in watch mode |
| `pnpm dev:full` | Server + chat UI together (clones UI on first run) |
| `pnpm dev:ui` | Chat UI only (assumes you already cloned `metaplex-agent-chat-template`) |
| `pnpm build` | Build all packages |
| `pnpm typecheck` | Type-check all packages |
| `pnpm bootstrap [public\|autonomous]` | Fork-time pruner — deletes the other mode's code paths |

---

## Testing

The repo ships a layered test suite built on `node --test` (no Jest, no Vitest). All three packages have unit and integration tests; the server package adds WebSocket E2E tests. The current suite is 404 tests / 88.98% line coverage; CI gates merges at 85%.

```bash
pnpm test              # all layers, all packages (builds dependents first)
pnpm test:unit         # pure-function tests, no I/O
pnpm test:integration  # tool execute() paths and agent assembly with mocked RPC/HTTP
pnpm test:e2e          # real WebSocket server + real ws client + mocked Solana + stubbed model
pnpm test:coverage     # emits packages/*/coverage/lcov.info
```

Each package follows the same layout:

```text
packages/<pkg>/test/
  helpers/        # shared mocks (mock-rpc, stub agents, env isolation)
  unit/           # pure functions, deterministic
  integration/    # tool execute() with mocked RPC/HTTP
  e2e/            # server package only — full PlexChat conversations
```

To run a single test file:

```bash
pnpm --filter @metaplex-foundation/shared exec node --test --import tsx test/unit/state.test.ts
```

To enforce coverage locally (same gate CI runs):

```bash
pnpm test:coverage && tsx scripts/check-coverage.ts
```

Conventions, helper inventory, and recipes for adding new tool tests or E2E scenarios live in [`docs/testing.md`](./docs/testing.md).

---

## Plumber-backed mode

By default the template pulls inference, image generation, Solana RPC, and DAS calls from a remote **agent-plumber** service so operators don't need to provision provider keys or a paid RPC up front. Payments use the canonical [x402 v2](https://www.x402.org/) protocol with the SVM-exact scheme — USDC over Solana, plumber acting as facilitator + fee-payer.

**Configure.** Set `PLUMBER_URL` in `.env` to the base URL of a plumber instance (e.g. `https://plumber.example.com`). Leave `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GOOGLE_GENERATIVE_AI_API_KEY` and `SOLANA_RPC_URL` unset — they're only consulted when `PLUMBER_URL` is empty (escape hatch / fully self-hosted mode).

**Prereqs in plumber mode.**

1. The agent's `AGENT_KEYPAIR` needs a USDC token account funded with enough USDC to pay for calls (devnet USDC mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`).
2. **That's it.** No Solana RPC. No SOL on the agent's keypair (plumber sponsors tx fees as the x402 fee-payer). No provider API keys.

**How it works.**

```
LLM call (Mastra) ──▶ AI SDK openai-compatible ─┐
Solana RPC call ────▶ web3.js Connection ───────┼──▶ plumberFetch ──▶ HTTPS to plumber /v1/*
DAS call ───────────▶ (same as RPC) ────────────┘   (transparent x402 v2 retry)
```

Plumber exposes OpenAI-compatible endpoints (`/v1/chat/completions`, `/v1/images/generations`), a Solana JSON-RPC passthrough at `/v1/solana/rpc`, and the canonical x402 facilitator endpoints (`/verify`, `/settle`). The template wires it all up through standard primitives:

- **LLM:** `createOpenAICompatible({ baseURL: ${PLUMBER_URL}/v1, fetch: plumberFetch })` from `@ai-sdk/openai-compatible`. Mastra accepts the resulting `LanguageModelV2` directly — no custom bridge.
- **Solana RPC / DAS:** Umi is built with `createUmi(${PLUMBER_URL}/v1/solana/rpc, { fetch: plumberFetch })`. Every `umi.rpc.*` call (including DAS) becomes a JSON-RPC POST that plumberFetch transparently pays for.

`plumberFetch(client)` implements the canonical x402 v2 client side:

1. On HTTP 402, decode the `PaymentRequired` body. Plumber populates `extra.feePayer` (its own keypair), `extra.blockhash`, and `extra.memo` so the client can build the tx without an RPC.
2. Build a `TransferChecked` USDC partial tx with the required compute-budget + memo instructions per [x402 SVM-exact spec](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md). Sign as the transfer `authority` only — `feePayer` slot stays empty for plumber to co-sign.
3. Base64-encode the partial tx into a `PaymentPayload`, retry with `X-PAYMENT` header.
4. Plumber's `/verify` + `/settle` facilitator: validates instruction layout, co-signs as fee-payer, submits, returns `X-PAYMENT-RESPONSE`.

Net effect: the template makes **zero direct Solana RPC calls** in plumber mode and the agent's keypair holds **zero SOL** — plumber absorbs the network fee as a facilitator courtesy and recovers it from the USDC margin.

**Falling back to BYOK.** Unset `PLUMBER_URL`, fill in one provider key, and the agent calls Anthropic/OpenAI/Google directly. Useful for offline development or self-hosted production where the plumber service isn't available.

---

## License

See [LICENSE](./LICENSE).
