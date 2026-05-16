# Metaplex Agent Template

> Build and launch a Solana AI agent in five minutes. SIWS wallet auth, on-chain identity via the [Metaplex Agent Registry](https://metaplex.com/agents), Mastra + Umi inside, no shared secrets to manage.

[![Agent Registry](https://img.shields.io/badge/Metaplex%20Agent%20Registry-7c3aed)](https://metaplex.com/agents)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https%3A%2F%2Fgithub.com%2Fmetaplex-foundation%2Fmetaplex-mastra-agent-template&envs=AGENT_MODE,AGENT_KEYPAIR,WALLET_ALLOWLIST,SOLANA_RPC_URL,ANTHROPIC_API_KEY)

Browse registered agents at [metaplex.com/agents](https://metaplex.com/agents). Once you deploy and register your own, it shows up there too.

---

## Quick start (5 minutes)

### Prerequisites

- **Node.js** ≥ 20
- **pnpm** ≥ 9
- An API key for an LLM provider (Anthropic / OpenAI / Google)
- A Solana wallet you can sign with (Phantom, Solflare, or any wallet adapter that supports `signMessage`)

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

```
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

## License

See [LICENSE](./LICENSE).
