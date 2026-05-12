# Deployment

Two first-class recipes — one per agent mode. Pick the section that matches your `AGENT_MODE`; the other mode's recipe is safe to ignore.

> This document covers production shape only. For local development see the main [README](../README.md). For the protocol spec see [`WEBSOCKET_PROTOCOL.md`](../WEBSOCKET_PROTOCOL.md).

---

## Auth tiers

WebSocket authentication is wallet-signature-based (Sign-In-With-Solana). Every connection completes a SIWS handshake before any chat-plane traffic is accepted, and the wallet that signs the challenge becomes the session's `walletAddress`. There is no shared secret to leak — the legacy `WEB_CHANNEL_TOKEN` is gone.

`AGENT_AUTH_MODE` selects which wallets are allowed to authenticate. When unset, the mode is auto-resolved from `AGENT_MODE`:

| Tier | Default for | Allowed wallets | When to pick it |
|---|---|---|---|
| `owner` | `AGENT_MODE=autonomous` | Only the on-chain agent asset owner (resolved from `AGENT_ASSET_ADDRESS` or `BOOTSTRAP_WALLET` pre-registration). | Headless autonomous agents; owner-only inspection consoles. Nothing to configure — the owner is auto-resolved. |
| `allowlist` | `AGENT_MODE=public` if `WALLET_ALLOWLIST` is non-empty | Owner ∪ wallets in `wallets.allowlist.json` (file) ∪ `WALLET_ALLOWLIST` env. | Invite-only public deployments: closed beta, paid users, internal tooling. |
| `open` | `AGENT_MODE=public` if no allowlist is configured | Any wallet that completes a valid SIWS signature. | Genuinely public agents. Lean on per-wallet rate limits and LLM cost budgets to bound abuse. |

The owner is **always** authorized regardless of tier — there is no need to list yourself.

**Allowlist sources.** Two sources, merged and deduplicated:

1. **File (primary):** `wallets.allowlist.json` at the workspace root with shape `{ "wallets": ["pk1", "pk2", ...] }`. The path is overridable via `WALLET_ALLOWLIST_PATH`. Hot-reloaded every 5s by mtime polling — operators can add or remove wallets without restarting the server. The file is gitignored; ship `wallets.allowlist.example.json` instead.
2. **Env (fallback):** `WALLET_ALLOWLIST=pk1,pk2,...` for cloud deploys without writable filesystems (Railway, Fly, etc.). Empty entries are dropped.

**Tunables (all optional, defaults shown):**

| Var | Default | Notes |
|---|---|---|
| `AGENT_AUTH_MODE` | auto-resolved | `owner` / `allowlist` / `open` — explicit override of the auto-default |
| `WALLET_ALLOWLIST` | (empty) | comma-separated base58 pubkeys |
| `WALLET_ALLOWLIST_PATH` | `wallets.allowlist.json` | override the file path if you mount it elsewhere |
| `AUTH_NONCE_TTL_MS` | `60000` | how long an issued nonce is valid |
| `AUTH_HANDSHAKE_TIMEOUT_MS` | `30000` | how long to wait for `auth_response` before closing |
| `WALLET_RATE_LIMIT_MAX` | `60` | per-wallet chat-message cap (post-auth) |
| `WALLET_RATE_LIMIT_WINDOW_MS` | `60000` | sliding window for the per-wallet limiter |
| `WALLET_RATE_LIMIT_MAX_KEYS` | `10000` | LRU cap on tracked wallets |

See [`WEBSOCKET_PROTOCOL.md`](../WEBSOCKET_PROTOCOL.md) § Authentication for the wire-level handshake and [`docs/SPEC.md`](./SPEC.md) §5.1 for the canonical auth model.

---

## Public Mode — Multi-user chatbot behind a TLS proxy

**Intended shape:** a long-lived WebSocket server sitting behind a reverse proxy that terminates TLS, serving many concurrent users who sign their own transactions in a browser wallet.

### Runtime topology

```
 Browser wallet (Phantom/Solflare)
          │ HTTPS + WSS
          ▼
 ┌─────────────────────────────┐
 │  CDN / WAF (Cloudflare)      │   optional but recommended
 └──────────────┬──────────────┘
                │ WSS
                ▼
 ┌─────────────────────────────┐
 │  Reverse proxy (nginx / ALB) │   terminates TLS, forwards Upgrade
 └──────────────┬──────────────┘
                │ WS (plaintext, loopback/VPC)
                ▼
 ┌─────────────────────────────┐
 │  @metaplex-foundation/server      │   one or many replicas, stateless per session
 └──────────────┬──────────────┘
                │ HTTPS
                ▼
 ┌─────────────────────────────┐
 │  Solana RPC (Helius/Triton)  │
 └─────────────────────────────┘
```

### Minimum hardening checklist

- [ ] Terminate TLS at the proxy. The SIWS handshake itself is replay-protected, but transport encryption still matters for `auth_response` confidentiality and chat-content privacy.
- [ ] Pick the right `AGENT_AUTH_MODE` tier (see "Auth tiers" above). For invite-only deployments use `allowlist` and populate `wallets.allowlist.json` or `WALLET_ALLOWLIST`. Reserve `open` for agents you genuinely want to expose to any wallet on the internet.
- [ ] Set `WS_ALLOWED_ORIGINS` to the exact origins allowed to open a WebSocket (CSWSH protection). Leaving localhost defaults in production is a bug.
- [ ] Tune the per-wallet rate limit (`WALLET_RATE_LIMIT_MAX` / `WALLET_RATE_LIMIT_WINDOW_MS`) to match your expected legitimate traffic; the defaults (60 messages / 60s) are a starting point, not a recommendation.
- [ ] Put an application-layer gateway (Cloudflare, nginx `limit_req`, AWS WAF) in front to cap **handshake** attempts by IP — SIWS verification is cheap but not free, and an attacker can burn nonces without authenticating.
- [ ] Set `SOLANA_RPC_URL` to a dedicated RPC provider. `api.devnet.solana.com` is development-only.
- [ ] Set `MAX_MESSAGE_CONTENT`, `MAX_RPC_TIME_BUDGET_MS`, `MAX_STEPS` to values that match your expected load and LLM cost tolerance.
- [ ] Store the LLM API key and `AGENT_KEYPAIR` in a secrets manager (AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault) rather than a raw `.env` file.

### Scaling notes

- The server is **stateless per session**: each WebSocket connection owns its wallet state, history, and pending-tx queue. You can run N replicas behind a load balancer provided the load balancer supports sticky WebSockets (nginx `ip_hash`, ALB target group with stickiness, etc.) — once a user's WS is routed to a replica, subsequent messages on the same connection must go to the same replica.
- Per-user state (conversation history, per-user JWTs) should live in an external store if you need durability across replica restarts.
- `agent-state.json` is per-process and fine for the agent's own registration state; do **not** use it for per-user data.

### Example nginx block

```nginx
upstream agent_server {
  server 127.0.0.1:3002;
  keepalive 32;
}

server {
  listen 443 ssl http2;
  server_name agent.example.com;

  ssl_certificate     /etc/letsencrypt/live/agent.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/agent.example.com/privkey.pem;

  location /ws {
    proxy_pass http://agent_server;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;

    # Cap handshake attempts per IP (tune for your traffic)
    limit_req zone=ws_handshake burst=10 nodelay;
  }
}
```

### Example `.env` (production excerpts)

```dotenv
AGENT_MODE=public
AGENT_KEYPAIR=${AGENT_KEYPAIR_FROM_SECRETS_MANAGER}
AGENT_AUTH_MODE=allowlist
WALLET_ALLOWLIST=${COMMA_SEPARATED_OPERATOR_PUBKEYS}
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}
WS_ALLOWED_ORIGINS=https://app.example.com
AGENT_FEE_SOL=0.001
MAX_CONNECTIONS=500
MAX_MESSAGE_CONTENT=4000
```

### Example Dockerfile (public mode)

```dockerfile
FROM node:20-slim AS builder
WORKDIR /app
RUN corepack enable
COPY pnpm-*.yaml package.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:20-slim
WORKDIR /app
COPY --from=builder /app ./
ENV NODE_ENV=production
EXPOSE 3002
CMD ["node", "packages/server/dist/index.js"]
```

---

## Autonomous Mode — Headless agent with key custody

**Intended shape:** a single-owner process running on its own (k8s Deployment, systemd unit, or scheduled job). The agent signs transactions with its own keypair — that keypair is the most sensitive secret in the system.

### Runtime topology

```
 Owner wallet (SIWS required; authorization = owner-only)
          │  (optional) WSS for manual inspection
          ▼
 ┌─────────────────────────────┐
 │  @metaplex-foundation/server      │   single replica, AGENT_AUTH_MODE=owner
 │  OR                          │
 │  Custom worker loop          │   event-driven / cron / once-per-hour
 └──────────────┬──────────────┘
                │
                ▼
 ┌─────────────────────────────┐
 │  Solana RPC                  │
 └─────────────────────────────┘

 AGENT_KEYPAIR ← mounted from Vault / Secrets Manager / KMS
```

**Authentication vs authorization in this topology.** Every connection — including the owner's manual-inspection WSS session — completes the same SIWS handshake (the *authentication* mechanism, unchanged across tiers). `AGENT_AUTH_MODE=owner` controls *authorization*: only the wallet that matches the on-chain Agent Asset owner is admitted past the handshake; any other valid SIWS signature is rejected with `auth_error: not_authorized` and a `4001` close. The two layers are independent — switching tiers does not change the wire-level handshake.

### Minimum hardening checklist

- [ ] **Treat `AGENT_KEYPAIR` as a privileged secret.** It has direct access to the agent's funds. Fund the agent wallet with only what it needs; don't give it the entire treasury.
- [ ] Store `AGENT_KEYPAIR` in a secrets manager (AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault). Mount it as a file at startup — never bake it into container images.
- [ ] Consider routing signing through a KMS/HSM-backed signer if your chain of custody requires it. (The template uses an in-process Ed25519 signer today; replacing `createSignerFromKeypair` with a KMS-backed signer is a localized change in `packages/shared/src/umi.ts`.)
- [ ] **Do not expose the WebSocket port publicly.** Autonomous agents do not need ingress. Bind to localhost or a private VPC subnet, or remove the server entirely and use a worker-loop shape (see below).
- [ ] Set `BOOTSTRAP_WALLET` to the pubkey that will do the first `register-agent` call. After registration, the on-chain asset owner takes precedence and this variable is no longer consulted.
- [ ] Set `SOLANA_RPC_URL` to a dedicated RPC provider. Rate-limited public RPC endpoints will cause silent trade failures.
- [ ] Alert on keypair balance falling below a runtime threshold — the agent can't sign transactions without SOL.
- [ ] Alert on owner-change events (the asset owner on-chain is the sole authority; ownership transfers should be rare and logged).
- [ ] Persist strategy state (positions, trade history) somewhere durable. `agent-state.json` is for registry identity only, not business state.

### Deployment shapes

**A. WebSocket server, owner-gated (default)**

Run `packages/server` as normal. Autonomous mode auto-resolves `AGENT_AUTH_MODE=owner`, so only the on-chain asset owner can complete the SIWS handshake — every other wallet is rejected with `auth_error: not_authorized` before the LLM is ever invoked. Useful if you want to manually inspect or instruct the agent from an owner-wallet UI.

Bind to localhost or a VPC-internal interface — do not expose port 3002 to the public internet even with owner-only auth. Ingress is unneeded.

**B. Worker loop, no WebSocket**

If the agent is purely schedule-driven (e.g. "rebalance every hour"), delete `packages/server` and write a thin worker instead:

```typescript
// packages/worker/src/index.ts (custom; you write this)
import { createAgent } from '@metaplex-foundation/core';
import { RequestContext } from '@mastra/core/request-context';
import { readAgentState, getConfig } from '@metaplex-foundation/shared';

const agent = createAgent();
const state = readAgentState();

async function tick() {
  const ctx = new RequestContext([
    ['agentMode', 'autonomous'],
    ['agentAssetAddress', state.agentAssetAddress],
    ['agentTokenMint', state.agentTokenMint],
    ['agentFeeSol', 0],
    ['ownerWallet', null],
    ['walletAddress', null],
    ['transactionSender', null],
    ['tokenOverride', getConfig().TOKEN_OVERRIDE ?? null],
  ]);

  const result = await agent.generate('Run the rebalance strategy.', {
    requestContext: ctx as any,
  });

  console.log(result.text);
}

setInterval(tick, 60 * 60 * 1000); // hourly
tick();
```

### Example `.env` (autonomous excerpts)

```dotenv
AGENT_MODE=autonomous
AGENT_KEYPAIR=${AGENT_KEYPAIR_FROM_SECRETS_MANAGER}
BOOTSTRAP_WALLET=${OWNER_WALLET_PUBKEY}
# AGENT_AUTH_MODE auto-resolves to 'owner' in autonomous mode. Only the agent's
# on-chain asset owner (or BOOTSTRAP_WALLET pre-registration) can authenticate.
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}
JUPITER_API_KEY=${JUPITER_API_KEY_FROM_SECRETS_MANAGER}
```

### Example Kubernetes Deployment (autonomous, worker shape)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: metaplex-agent-autonomous
spec:
  replicas: 1
  strategy:
    type: Recreate          # single-owner; no rolling updates
  selector:
    matchLabels:
      app: metaplex-agent
  template:
    metadata:
      labels:
        app: metaplex-agent
    spec:
      containers:
        - name: agent
          image: your-registry/metaplex-agent-autonomous:latest
          env:
            - name: AGENT_MODE
              value: autonomous
            - name: AGENT_KEYPAIR
              valueFrom:
                secretKeyRef:
                  name: agent-secrets
                  key: AGENT_KEYPAIR
            - name: BOOTSTRAP_WALLET
              valueFrom:
                secretKeyRef:
                  name: agent-secrets
                  key: BOOTSTRAP_WALLET
            - name: SOLANA_RPC_URL
              valueFrom:
                secretKeyRef:
                  name: agent-secrets
                  key: SOLANA_RPC_URL
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: agent-secrets
                  key: ANTHROPIC_API_KEY
          # no ports exposed
```

### Example Dockerfile (autonomous mode)

```dockerfile
FROM node:20-slim AS builder
WORKDIR /app
RUN corepack enable
COPY pnpm-*.yaml package.json ./
COPY packages/shared ./packages/shared
COPY packages/core ./packages/core
COPY packages/server ./packages/server
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @metaplex-foundation/shared --filter @metaplex-foundation/core --filter @metaplex-foundation/server build

FROM node:20-slim
WORKDIR /app
COPY --from=builder /app ./
ENV NODE_ENV=production
# No EXPOSE — autonomous agents do not need public ingress
CMD ["node", "packages/server/dist/index.js"]
```

---

## Railway (step-by-step, both modes)

[Railway](https://railway.com) is the quickest path from `git push` to a running agent. The repo ships a `Dockerfile` and `railway.json` at the root so Railway builds and runs `packages/server` without any extra configuration. The UI package is **not** deployed by this recipe — put it on Vercel (or wherever you prefer) and point it at the Railway-hosted WSS URL.

### What's included in the template

- `Dockerfile` — multi-stage build that compiles `shared` → `core` → `server` and ships a non-root runtime image. Works on Railway, Fly, Render, k8s, or `docker run` locally.
- `.dockerignore` — keeps `node_modules`, `.env`, the UI package, and other local-only files out of the build context.
- `railway.json` — tells Railway to use the Dockerfile, sets the start command, and configures a restart policy. Railway reads this automatically.

The server reads `WEB_CHANNEL_PORT` and falls back to `PORT` if unset. Railway's domain-generation step insists on a fixed target port, so the cleanest setup is to pin `WEB_CHANNEL_PORT=3002` in the service's variables and point the generated domain at `3002` — see Step 2.

### Prerequisites

- A Railway account and the [Railway CLI](https://docs.railway.com/guides/cli) (`npm i -g @railway/cli`), or just the web dashboard.
- Your agent's secrets ready to paste: `AGENT_KEYPAIR`, `SOLANA_RPC_URL`, and the LLM API key matching your `LLM_MODEL`.
- For public mode with `allowlist`: a comma-separated `WALLET_ALLOWLIST` of wallets allowed to chat with the agent. (Railway's filesystem is ephemeral, so the env-var source is preferable to the `wallets.allowlist.json` file on this platform.)
- For autonomous mode: `BOOTSTRAP_WALLET` (the pubkey that will trigger first-time registration). `AGENT_AUTH_MODE` auto-resolves to `owner` — no allowlist needed.

### Step 1 — Create the project

From the dashboard: **New Project → Deploy from GitHub repo → pick your fork**. Railway detects `railway.json` and queues the first build. (CLI equivalent: `railway login && railway init && railway up`.)

### Step 2 — Set environment variables

In the service's **Variables** tab, add the minimum set:

```
# Required (both modes)
AGENT_MODE=public                     # or autonomous
AGENT_KEYPAIR=<base58 secret or JSON byte array>
WEB_CHANNEL_PORT=3002                  # pin so Railway's domain target matches
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
ANTHROPIC_API_KEY=<your key>           # or OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY
WS_ALLOWED_ORIGINS=https://your-ui-domain.com

# Public mode (allowlist tier — recommended for invite-only beta)
AGENT_AUTH_MODE=allowlist
WALLET_ALLOWLIST=<pubkey1>,<pubkey2>   # comma-separated; owner is always allowed
AGENT_FEE_SOL=0.001

# Autonomous mode
BOOTSTRAP_WALLET=<owner pubkey>
# AGENT_AUTH_MODE auto-resolves to 'owner' — no further auth config needed
```

See [`.env.example`](../.env.example) for the full catalog of tunables (`MAX_CONNECTIONS`, `MAX_MESSAGE_CONTENT`, `MAX_RPC_TIME_BUDGET_MS`, etc.).

**Pin `WEB_CHANNEL_PORT=3002`.** Railway's "Generate Domain" step asks for a fixed target port; pinning the binding port matches it and removes the dynamic-`PORT` guesswork.

**Treat `AGENT_KEYPAIR` as a privileged secret** in autonomous mode. It has direct access to the agent's funds; fund the wallet with only what it needs.

### Step 3 — Expose the service

In **Settings → Networking → Public Networking**, click **Generate Domain** and set the target port to **3002** (matching `WEB_CHANNEL_PORT`). Railway hands you a URL like `your-agent-production.up.railway.app`. The WebSocket endpoint is `wss://your-agent-production.up.railway.app` (TLS is terminated at Railway's edge — the server keeps speaking plain `ws://` internally).

For **autonomous mode**, skip this step. Autonomous agents don't need public ingress — leave networking closed and connect only via the Railway **Private Networking** hostname if you need to reach it from another service in the same project.

### Step 4 — Deploy and tail logs

Railway auto-deploys on every push to the tracked branch. Tail the build and runtime logs in the **Deployments** tab (or `railway logs` via CLI). You should see:

```
PlexChat WebSocket server running on ws://localhost:<PORT>
Agent mode: public
Agent name: Agent
RPC: https://...
```

### Step 5 — Register the agent (first run)

Before registration the agent has no on-chain asset. In **public mode**, the first user wallet that connects triggers `register-agent`; the server then writes `agentAssetAddress` and `agentTokenMint` into `agent-state.json`. In **autonomous mode**, only the `BOOTSTRAP_WALLET` can trigger it.

**Important for Railway**: Railway's container filesystem is ephemeral — `agent-state.json` is **wiped on every deploy**. Once the agent is registered, copy the addresses out of the logs and set them as env vars so subsequent deploys skip re-registration:

```
AGENT_ASSET_ADDRESS=<address from logs>
AGENT_TOKEN_MINT=<address from logs>   # only if launch-token ran
```

The config layer treats these env vars as authoritative when set, so the missing state file becomes a non-issue. (Alternatively, attach a [Railway volume](https://docs.railway.com/reference/volumes) at `/app` — but the env-var approach is simpler and avoids volume lifecycle edge cases.)

### Step 6 — Point the UI at the deployed server

In your UI deployment (e.g. Vercel), set:

```
NEXT_PUBLIC_WS_HOST=your-agent-production.up.railway.app
NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta
```

Then update `WS_ALLOWED_ORIGINS` on the Railway service to include the UI's public origin.

`wsUrl()` auto-selects `wss://` for any non-localhost `NEXT_PUBLIC_WS_HOST` and drops the port when it's the default (`443` for `wss`, `80` for `ws`) — so a managed TLS host like Railway only needs `NEXT_PUBLIC_WS_HOST`. Override the protocol explicitly with `NEXT_PUBLIC_WS_PROTOCOL=ws|wss` if your setup needs it (e.g. a non-TLS internal hostname).

The UI authenticates each connection via the SIWS handshake using the user's connected browser wallet — there is no shared token to inject. Make sure the wallets your users connect with are present in the agent's `WALLET_ALLOWLIST` (or that the agent runs in `open` mode if you want to accept any wallet).

#### Vercel setup (UI)

The chat UI is a separate repo: [`metaplex-agent-chat-template`](https://github.com/metaplex-foundation/metaplex-agent-chat-template) (or wherever you've forked it). Import that repo in Vercel and set:

- **Framework preset**: Next.js (auto-detected)
- **Root Directory**: leave at repo root
- **Install / Build Command**: defaults are fine — the UI is a standalone Next.js app with no workspace dependencies.

Set `NEXT_PUBLIC_WS_HOST` to your agent's public hostname and add the UI's deployed origin to `WS_ALLOWED_ORIGINS` on the agent. SIWS authentication happens entirely via the connected wallet — no UI-side secret to provision.

You can safely ignore the `pino-pretty` warning from `@walletconnect/logger` — it's an optional peer dep only used for dev-mode log formatting.

### Scaling and limits

- **Replicas**: Railway can run multiple replicas of a service (paid plans). The server is stateless *per session* but sticky WebSocket routing is required — see "Scaling notes" above. Railway's proxy doesn't currently guarantee WebSocket stickiness by source IP, so for multi-replica deployments you may want to front it with Cloudflare or add a session-affinity layer of your own.
- **Memory**: start with 512 MB; scale up if `@mastra/core` + the agent history pushes you over. The default `MAX_CONNECTIONS=10` keeps single-replica memory bounded.
- **Idle**: public-mode agents need to stay up to accept sessions. Disable any idle-sleep behavior on your Railway service's plan.
- **Cost**: the biggest variable is the LLM spend, not Railway. Set `MAX_STEPS` and `MAX_RPC_TIME_BUDGET_MS` aggressively if you're letting the public internet chat with the agent.

### Autonomous-mode caveat

If you deploy autonomous mode on Railway, **leave public networking off** and treat the service like a headless worker. The server package still listens on a port (which Railway assigns), but without a public domain nobody outside the project can reach it. The owner-gated WebSocket is only for manual inspection from inside the project.

For a pure cron-shape autonomous agent (no WebSocket at all), replace `packages/server` with a worker loop per the example above — Railway will happily run that too; just keep the Dockerfile pointed at your worker's entry.

---

## Observability (both modes)

The server emits structured `console.log` events and, when `ENABLE_DEBUG_EVENTS=true`, streams `debug:*` events over the WebSocket. In production:

- Ship stdout/stderr to your log aggregator (Datadog, CloudWatch, Loki, etc.).
- Alert on:
  - `authLogger` warnings (`LOG_AUTH_FAILURES=true`) — origin rejections, SIWS handshake failures (`signature_invalid`, `nonce_expired`, `not_authorized`, `auth_timeout`), and per-wallet rate-limit breaches.
  - RPC time-budget exhaustion events (`MAX_RPC_TIME_BUDGET_MS`).
  - Repeated tool errors from a single session (possible prompt injection probing).
- For autonomous mode, additionally alert on:
  - Keypair balance falling below a buffer (e.g. 0.05 SOL).
  - Failed `sendAndConfirm` retries (network-level failures during trade execution).
  - Unexpected owner changes on the agent asset.

---

## Switching modes

`AGENT_MODE` is read at startup. Restart the server after changing it. The two modes share the same on-chain identity (keypair + registry asset + PDA wallet + optional token), so you can flip an agent between modes without losing its identity — useful for testing a trading bot interactively in public mode, then running it headless in autonomous mode.

Running both modes simultaneously against the same keypair requires two server instances with different `.env` files and different ports. Make sure they don't race on `agent-state.json` writes (point one to a read-only copy, or disable state writes on the secondary).
