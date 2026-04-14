# @metaplex-agent/shared

The shared foundation for the Metaplex Agent Template. This package provides the configuration system, Umi factory, transaction helpers, protocol types, and context interfaces used by both the core agent and the WebSocket server.

## Overview

Everything in this package is re-exported from `src/index.ts`:

```typescript
export * from './types/protocol.js';
export * from './types/agent.js';
export * from './config.js';
export * from './umi.js';
export * from './transaction.js';
```

Other packages import from `@metaplex-agent/shared` directly:

```typescript
import {
  getConfig,
  createUmi,
  submitOrSend,
  type AgentContext,
  type TransactionSender,
  type ServerTransaction,
  type ClientMessage,
  type ServerMessage,
} from '@metaplex-agent/shared';
```

## Configuration System

**File**: `src/config.ts`

The `getConfig()` function loads environment variables from the workspace root `.env` file (via `dotenv`) and validates them against a Zod schema. The result is cached after the first call.

### Environment Variables

| Variable            | Type                         | Default                              | Required | Description                                  |
|---------------------|------------------------------|--------------------------------------|----------|----------------------------------------------|
| `AGENT_MODE`        | `'public' \| 'autonomous'`  | `'public'`                           | No       | Controls transaction signing behavior.       |
| `LLM_MODEL`        | `string`                     | `'anthropic/claude-sonnet-4-5-20250929'` | No       | LLM provider and model in `provider/model` format. |
| `SOLANA_RPC_URL`    | `string`                     | `'https://api.devnet.solana.com'`    | No       | Solana RPC endpoint URL.                     |
| `AGENT_KEYPAIR`     | `string`                     | --                                   | No*      | Base58-encoded secret key. *Required in autonomous mode. |
| `WEB_CHANNEL_PORT`  | `number`                     | `3002`                               | No       | WebSocket server port.                       |
| `WEB_CHANNEL_TOKEN` | `string`                     | --                                   | **Yes**  | Auth token for WebSocket connections.        |
| `ASSISTANT_NAME`    | `string`                     | `'Agent'`                            | No       | Display name for agent chat messages.        |

### Zod Schema

The schema validates and coerces environment variables at startup:

```typescript
const envSchema = z.object({
  AGENT_MODE: z.enum(['public', 'autonomous']).default('public'),
  LLM_MODEL: z.string().default('anthropic/claude-sonnet-4-5-20250929'),
  SOLANA_RPC_URL: z.string().default('https://api.devnet.solana.com'),
  AGENT_KEYPAIR: z.string().optional(),
  WEB_CHANNEL_PORT: z.coerce.number().default(3002),
  WEB_CHANNEL_TOKEN: z.string().min(1, 'WEB_CHANNEL_TOKEN is required'),
  ASSISTANT_NAME: z.string().default('Agent'),
});
```

If validation fails, `getConfig()` throws an error listing all invalid fields with messages.

### Usage

```typescript
import { getConfig } from '@metaplex-agent/shared';

const config = getConfig();
console.log(config.AGENT_MODE);      // 'public' or 'autonomous'
console.log(config.SOLANA_RPC_URL);  // 'https://api.devnet.solana.com'
```

## Umi Factory

**File**: `src/umi.ts`

The `createUmi()` function creates a fully configured Metaplex Umi instance based on the current environment.

### Behavior by Mode

**Both modes**:
- Connects to the Solana RPC at `SOLANA_RPC_URL`
- Registers the `mpl-toolbox` plugin (provides token operations, transfers, etc.)

**Autonomous mode** (additionally):
- Reads `AGENT_KEYPAIR` (base58-encoded secret key)
- Decodes the keypair and sets it as the Umi identity and payer via `signerIdentity()`
- Throws an error if `AGENT_KEYPAIR` is not set

**Public mode**:
- No signer is configured. Transactions are built with a noop signer and sent to the frontend for signing.

### Usage

```typescript
import { createUmi } from '@metaplex-agent/shared';

const umi = createUmi();
// Use umi.rpc for RPC calls, umi.identity for the signer (autonomous mode)
```

## Transaction Helpers

**File**: `src/transaction.ts`

### submitOrSend

The central function for executing transactions in a mode-aware way.

```typescript
async function submitOrSend(
  umi: Umi,
  builder: TransactionBuilder,
  context: AgentContext,
  options?: { message?: string; index?: number; total?: number }
): Promise<string>
```

**Parameters**:

| Parameter  | Type                 | Description                                                  |
|------------|----------------------|--------------------------------------------------------------|
| `umi`      | `Umi`                | A configured Umi instance from `createUmi()`.                |
| `builder`  | `TransactionBuilder` | A Umi transaction builder with instructions added.           |
| `context`  | `AgentContext`       | Agent context containing wallet address and transaction sender. |
| `options`  | `object` (optional)  | Optional metadata: `message` (description), `index`/`total` (for multi-tx sequences). |

**Return value**:

- **Public mode**: Returns the string `'sent-to-wallet'`. The transaction was serialized and pushed to the frontend via WebSocket.
- **Autonomous mode**: Returns the base58-encoded transaction signature after on-chain confirmation.

### Public Mode Flow

1. Validates that `context.transactionSender` and `context.walletAddress` are present.
2. Creates a noop signer for the user's wallet address (so the transaction can be built without their private key).
3. Sets the user as the fee payer and builds the transaction.
4. Serializes to base64.
5. Calls `context.transactionSender.sendTransaction()` to push the transaction over WebSocket.

### Autonomous Mode Flow

1. Calls `builder.sendAndConfirm(umi)` which signs with the agent's keypair (configured on the Umi instance) and submits to the Solana RPC.
2. Encodes the returned signature bytes as base58.

## Protocol Types

**File**: `src/types/protocol.ts`

All PlexChat WebSocket protocol message types are defined here as TypeScript interfaces. The full protocol specification is in [WEBSOCKET_PROTOCOL.md](../../WEBSOCKET_PROTOCOL.md) at the repository root.

### Client to Server (ClientMessage)

| Type                      | Interface               | Fields                                    |
|---------------------------|-------------------------|-------------------------------------------|
| `message`                 | `ClientChatMessage`     | `content: string`, `sender_name?: string` |
| `wallet_connect`          | `ClientWalletConnect`   | `address: string`                         |
| `wallet_disconnect`       | `ClientWalletDisconnect`| *(none beyond type)*                      |

```typescript
export type ClientMessage =
  | ClientChatMessage
  | ClientWalletConnect
  | ClientWalletDisconnect;
```

### Server to Client (ServerMessage)

| Type                  | Interface                 | Fields                                                          |
|-----------------------|---------------------------|-----------------------------------------------------------------|
| `connected`           | `ServerConnected`         | `jid: string`                                                   |
| `message`             | `ServerChatMessage`       | `content: string`, `sender: string`                             |
| `typing`              | `ServerTyping`            | `isTyping: boolean`                                             |
| `transaction`         | `ServerTransaction`       | `transaction: string`, `message?: string`, `index?: number`, `total?: number` |
| `wallet_connected`    | `ServerWalletConnected`   | `address: string`                                               |
| `wallet_disconnected` | `ServerWalletDisconnected`| *(none beyond type)*                                            |
| `error`               | `ServerError`             | `error: string`                                                 |

```typescript
export type ServerMessage =
  | ServerConnected
  | ServerChatMessage
  | ServerTyping
  | ServerTransaction
  | ServerWalletConnected
  | ServerWalletDisconnected
  | ServerError;
```

## AgentContext and TransactionSender

**File**: `src/types/agent.ts`

### AgentContext

The context object passed to tools during execution. It is populated by the server and injected into the Mastra `RequestContext`.

```typescript
export interface AgentContext {
  walletAddress: string | null;
  transactionSender: TransactionSender | null;
  agentMode: 'public' | 'autonomous';
}
```

| Field               | Type                       | Description                                                    |
|---------------------|----------------------------|----------------------------------------------------------------|
| `walletAddress`     | `string \| null`           | The connected user's Solana wallet address, or null if none.   |
| `transactionSender` | `TransactionSender \| null`| Interface for pushing transactions to the frontend.            |
| `agentMode`         | `'public' \| 'autonomous'` | The active agent mode, read from configuration.                |

### TransactionSender

An abstraction for delivering serialized transactions to a connected client. In the server package, this wraps the WebSocket broadcast method. In autonomous mode it is never called.

```typescript
export interface TransactionSender {
  sendTransaction(tx: ServerTransaction): void;
}
```

The single method `sendTransaction` accepts a `ServerTransaction` object (with `type: 'transaction'`, the base64 transaction string, and optional metadata) and pushes it to all connected WebSocket clients.

## Adding New Shared Utilities

To add a new shared utility:

1. Create a new file in `src/`, for example `src/my-helper.ts`:

```typescript
import { getConfig } from './config.js';

export function myHelper(): string {
  const config = getConfig();
  return `RPC: ${config.SOLANA_RPC_URL}`;
}
```

2. Re-export it from `src/index.ts`:

```typescript
export * from './types/protocol.js';
export * from './types/agent.js';
export * from './config.js';
export * from './umi.js';
export * from './transaction.js';
export * from './my-helper.js';
```

3. Import it in other packages:

```typescript
import { myHelper } from '@metaplex-agent/shared';
```

For new TypeScript types, add them to the appropriate file in `src/types/` or create a new types file and re-export it from `src/index.ts`.

## File Structure

```
packages/shared/
  src/
    config.ts              # Environment config with Zod validation
    umi.ts                 # Umi factory (mode-aware)
    transaction.ts         # submitOrSend helper
    index.ts               # Barrel exports
    types/
      protocol.ts          # PlexChat WebSocket protocol types
      agent.ts             # AgentContext and TransactionSender interfaces
  package.json
```
