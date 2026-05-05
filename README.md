# Metaplex Agent Template

> Build and launch a Solana AI agent in five minutes. SIWS wallet auth, on-chain identity via the [Metaplex Agent Registry](https://agents.metaplex.com), Mastra + Umi inside, no shared secrets to manage.

[![Try the demo](https://img.shields.io/badge/Try%20the%20demo-agents.metaplex.com-7c3aed)](https://agents.metaplex.com)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https%3A%2F%2Fgithub.com%2Fmetaplex-foundation%2Fmetaplex-mastra-agent-template&envs=AGENT_MODE,AGENT_KEYPAIR,WALLET_ALLOWLIST,SOLANA_RPC_URL,ANTHROPIC_API_KEY)

> **Demo:** screencast and a hosted public-tier agent are coming soon — the badge above will go live as part of the agents.metaplex.com gallery launch.

---

## Try it now

The fastest way to see what this builds is to chat with a hosted agent before forking anything. Open the demo, connect a Solana wallet (Phantom / Solflare), sign the SIWS prompt, and you're in. No tokens, no setup.

> _(Demo URL TODO — see `docs/ux-audit-2026-05-04.md` item #6.)_

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

## License

See [LICENSE](./LICENSE).
