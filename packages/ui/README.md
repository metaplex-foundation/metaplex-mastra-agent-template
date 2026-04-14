# PlexChat Test UI

Lightweight Next.js app for testing the PlexChat WebSocket agent without spinning up metaplex.com.

## Quick Start

1. Copy the example env file and fill in your values:

```bash
cp .env.local.example .env.local
```

Set `NEXT_PUBLIC_WS_TOKEN` to match the `WEB_CHANNEL_TOKEN` in your server's `.env`.

2. Start the agent server and UI together from the workspace root:

```bash
pnpm dev:all
```

Or run just the UI:

```bash
pnpm dev:ui
```

3. Open http://localhost:3001

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `NEXT_PUBLIC_WS_HOST` | `localhost` | WebSocket server host |
| `NEXT_PUBLIC_WS_PORT` | `3002` | WebSocket server port |
| `NEXT_PUBLIC_WS_TOKEN` | _(empty)_ | Auth token (must match server's `WEB_CHANNEL_TOKEN`) |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Solana RPC endpoint |

## Features

- Real Solana wallet connection (Phantom, Solflare) via wallet adapter
- WebSocket chat with auto-reconnect
- Typing indicator
- Transaction approval flow (sign + send in browser)
- Connection status indicator
