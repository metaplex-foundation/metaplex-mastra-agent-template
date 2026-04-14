# Metaplex Agent Template

A pnpm monorepo template for building AI agents that integrate with the [Metaplex Agent Registry](https://agents.metaplex.com). Uses [Mastra](https://mastra.ai) as the agent framework, [Metaplex Umi](https://github.com/metaplex-foundation/umi) as the Solana toolkit, and the PlexChat WebSocket protocol for real-time frontend communication.

Out of the box you get a working Solana agent with balance queries, SOL/token transfers, and transaction lookups -- ready to extend with your own tools.

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
|  - Manages wallet state                               |
|  - Routes messages to the Mastra agent                |
|  - Broadcasts responses, typing indicators,           |
|    and transactions back to clients                   |
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
5. Agent text response is broadcast to all connected clients.

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
WEB_CHANNEL_TOKEN=<generate with: openssl rand -hex 24>
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

### Public Mode (1-to-many)

```
AGENT_MODE=public
```

The agent has **no keypair**. When a tool needs to execute a transaction, the agent serializes it and sends it over the WebSocket as a `transaction` message. The frontend wallet (Phantom, Solflare, etc.) signs and submits it.

**Use cases:** wallet cleanup bots, faucet agents, NFT minting assistants, any agent serving multiple users who sign their own transactions.

**How it works:**
- `createUmi()` returns a Umi instance with no signer identity.
- `submitOrSend()` builds the transaction with the connected wallet as fee payer (using a noop signer), serializes to base64, and pushes it through the `TransactionSender` callback.
- The tool returns `"sent-to-wallet"` and the agent tells the user to approve in their wallet.

### Autonomous Mode (1-to-1)

```
AGENT_MODE=autonomous
AGENT_KEYPAIR=<base58-encoded secret key>
```

The agent has **its own Solana keypair**. It signs and submits transactions directly to the network without user interaction.

**Use cases:** portfolio rebalancer, trading bot, automated treasury manager, any agent that acts independently.

**How it works:**
- `createUmi()` decodes `AGENT_KEYPAIR`, creates a signer, and sets it as the Umi identity and fee payer.
- `submitOrSend()` calls `builder.sendAndConfirm(umi)` and returns the transaction signature.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AGENT_MODE` | No | `public` | `"public"` or `"autonomous"` |
| `LLM_MODEL` | No | `anthropic/claude-sonnet-4-5-20250929` | Mastra model identifier (see below) |
| `ANTHROPIC_API_KEY` | If using Anthropic | -- | Anthropic API key |
| `OPENAI_API_KEY` | If using OpenAI | -- | OpenAI API key |
| `GOOGLE_GENERATIVE_AI_API_KEY` | If using Google | -- | Google Generative AI API key |
| `SOLANA_RPC_URL` | No | `https://api.devnet.solana.com` | Solana JSON-RPC endpoint |
| `AGENT_KEYPAIR` | In autonomous mode | -- | Base58-encoded secret key for the agent wallet |
| `WEB_CHANNEL_PORT` | No | `3002` | WebSocket server port |
| `WEB_CHANNEL_TOKEN` | **Yes** | -- | Shared secret for WebSocket authentication |
| `ASSISTANT_NAME` | No | `Agent` | Display name used in chat responses |

**LLM_MODEL format:** `<provider>/<model-id>`, using Mastra's model router. Examples:

- `anthropic/claude-sonnet-4-5-20250929`
- `openai/gpt-4o`
- `google/gemini-2.5-pro`

Set the corresponding API key environment variable for whichever provider you choose.

---

## Project Structure

```
metaplex-agent-template/
  .env.example                  # Environment variable reference
  package.json                  # Root workspace scripts (dev, build, typecheck)
  pnpm-workspace.yaml           # pnpm workspace definition
  tsconfig.json                 # Shared TypeScript config (ES2022, strict)
  WEBSOCKET_PROTOCOL.md         # Full PlexChat protocol specification

  packages/
    core/                       # @metaplex-agent/core
      src/
        agent.ts                # Mastra Agent definition, system prompt, model config
        tools/
          index.ts              # Tool registry -- add new tools here
          get-balance.ts        # Query SOL balance for any address
          get-token-balances.ts # Query all SPL token holdings for an address
          transfer-sol.ts       # Transfer SOL (public or autonomous)
          transfer-token.ts     # Transfer SPL tokens (public or autonomous)
          get-transaction.ts    # Look up transaction status by signature

    server/                     # @metaplex-agent/server
      src/
        index.ts                # Entry point -- creates and starts the server
        websocket.ts            # PlexChatServer class (auth, routing, broadcast)

    shared/                     # @metaplex-agent/shared
      src/
        config.ts               # Zod-validated env config loader (getConfig)
        umi.ts                  # Umi factory (createUmi) -- mode-aware signer setup
        transaction.ts          # submitOrSend() -- public/autonomous transaction routing
        types/
          protocol.ts           # PlexChat WebSocket message type definitions
          agent.ts              # AgentContext and TransactionSender interfaces

    ui/                         # @metaplex-agent/ui
      src/
        app/
          page.tsx              # Main page -- chat + wallet + transaction approval
          providers.tsx         # Solana wallet adapter context providers
          env.ts                # Client-side WebSocket URL builder
        hooks/
          use-plexchat.ts       # WebSocket hook (connect, messages, typing, reconnect)
        components/
          chat-panel.tsx        # Scrollable message list + input
          chat-message.tsx      # Single message bubble
          typing-indicator.tsx  # Animated typing dots
          transaction-approval.tsx  # Sign + send transaction overlay
```

---

## Adding New Tools

### 1. Create the tool file

Create a new file in `packages/core/src/tools/`. Here is an example read-only tool:

```typescript
// packages/core/src/tools/get-account-info.ts

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

Add it to the tool registry in `packages/core/src/tools/index.ts`:

```typescript
import { getBalance } from './get-balance.js';
import { getTokenBalances } from './get-token-balances.js';
import { transferSol } from './transfer-sol.js';
import { transferToken } from './transfer-token.js';
import { getTransaction } from './get-transaction.js';
import { getAccountInfo } from './get-account-info.js';  // <-- add import

export const tools = {
  getBalance,
  getTokenBalances,
  transferSol,
  transferToken,
  getTransaction,
  getAccountInfo,  // <-- add to registry
};
```

That is all that is needed. Mastra automatically exposes registered tools to the LLM.

### 3. Tools that write transactions

For tools that build and submit transactions, use the `submitOrSend` helper from `@metaplex-agent/shared`. This function handles both agent modes automatically:

- **Public mode:** serializes the transaction to base64 and pushes it to the frontend wallet via WebSocket.
- **Autonomous mode:** signs with the agent keypair and submits directly to the network.

See `transfer-sol.ts` for the full pattern. The key parts are:

```typescript
import { submitOrSend, type AgentContext } from '@metaplex-agent/shared';
import type { RequestContext } from '@mastra/core/request-context';

// Inside your tool's execute function:
execute: async ({ destination, amount }, { requestContext }) => {
  // Extract agent context from the request
  const ctx = requestContext as RequestContext<AgentContext> | undefined;
  const context: AgentContext = {
    walletAddress: ctx?.get('walletAddress') ?? null,
    transactionSender: ctx?.get('transactionSender') ?? null,
    agentMode: ctx?.get('agentMode') ?? 'public',
  };

  const umi = createUmi();

  // Build the transaction using Umi / mpl-toolbox
  const builder = transferSolIx(umi, { /* ... */ });

  // Submit or send -- handles both modes
  const result = await submitOrSend(umi, builder, context, {
    message: `Transfer ${amount} SOL to ${destination}`,
  });

  if (result === 'sent-to-wallet') {
    return { status: 'pending', message: 'Transaction sent to wallet for signing.' };
  }

  return { status: 'confirmed', signature: result, message: `Done. Signature: ${result}` };
};
```

---

## Customizing the Agent

### Changing the system prompt

Edit the `SYSTEM_PROMPT` constant in `packages/core/src/agent.ts`:

```typescript
const SYSTEM_PROMPT = `You are a DeFi portfolio assistant on Solana.
You help users track their holdings, suggest rebalancing strategies,
and execute swaps when asked. Always explain risks before executing trades.`;
```

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

### Server-to-client messages

| Type | Purpose |
|---|---|
| `connected` | Sent on successful WebSocket connection (unicast) |
| `message` | Agent chat response (broadcast) |
| `typing` | Typing indicator on/off (broadcast) |
| `transaction` | Serialized Solana transaction for wallet signing (broadcast) |
| `wallet_connected` | Wallet connection confirmed (broadcast) |
| `wallet_disconnected` | Wallet disconnection confirmed (broadcast) |
| `error` | Error response (unicast) |

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

The current auth model is a single shared token (`WEB_CHANNEL_TOKEN`). For production with multiple users, consider:
- Per-user JWT tokens validated on connection
- Session-based authentication tied to your application's auth system
- Rate limiting to prevent abuse

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
