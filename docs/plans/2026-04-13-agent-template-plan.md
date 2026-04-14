# Agent Template Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a reusable monorepo template for building Metaplex Agent Registry agents using Mastra, pnpm workspaces, TypeScript, and Metaplex Umi, with full PlexChat WebSocket protocol support.

**Architecture:** pnpm workspace monorepo with three packages: `shared` (types, Umi factory, transaction helpers), `core` (Mastra agent + tools), and `server` (WebSocket server). Agent mode (`public` vs `autonomous`) is config-driven and controls whether transactions route to the frontend for signing or execute server-side.

**Tech Stack:** TypeScript, pnpm workspaces, Mastra (`@mastra/core`), Metaplex Umi (`@metaplex-foundation/umi`, `umi-bundle-defaults`, `mpl-toolbox`), `ws` WebSocket library, `zod` for schemas, `dotenv` for config, `tsx` for dev.

---

### Task 1: Workspace Root Setup

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `.npmrc`

**Step 1: Create root package.json**

```json
{
  "name": "metaplex-agent-template",
  "version": "0.1.0",
  "private": true,
  "description": "Template for building Metaplex Agent Registry agents",
  "scripts": {
    "dev": "pnpm --filter @metaplex-agent/server dev",
    "build": "pnpm -r build",
    "clean": "pnpm -r clean",
    "typecheck": "pnpm -r typecheck"
  },
  "engines": {
    "node": ">=20"
  }
}
```

**Step 2: Create pnpm-workspace.yaml**

```yaml
packages:
  - "packages/*"
```

**Step 3: Create base tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "isolatedModules": true
  },
  "exclude": ["node_modules", "dist"]
}
```

**Step 4: Create .env.example**

```bash
# =============================================================================
# Agent Configuration
# =============================================================================

# Agent mode: "public" (1-to-many, no keypair, transactions sent to user wallet)
#             "autonomous" (1-to-1, agent has keypair, signs & submits transactions)
AGENT_MODE=public

# =============================================================================
# LLM Configuration
# =============================================================================

# Model identifier using Mastra's provider/model format
# Examples: anthropic/claude-sonnet-4-5-20250929, openai/gpt-4o, google/gemini-2.5-pro
LLM_MODEL=anthropic/claude-sonnet-4-5-20250929

# API key for the LLM provider
# Set the appropriate key for your chosen provider:
#   Anthropic: ANTHROPIC_API_KEY
#   OpenAI:    OPENAI_API_KEY
#   Google:    GOOGLE_GENERATIVE_AI_API_KEY
ANTHROPIC_API_KEY=

# =============================================================================
# Solana Configuration
# =============================================================================

# Solana RPC endpoint
SOLANA_RPC_URL=https://api.devnet.solana.com

# Agent keypair as base58-encoded secret key (autonomous mode only)
# Generate one with: solana-keygen new --no-bip39-passphrase --outfile /dev/stdout
AGENT_KEYPAIR=

# =============================================================================
# WebSocket Server (PlexChat Protocol)
# =============================================================================

# Port for the WebSocket server
WEB_CHANNEL_PORT=3002

# Authentication token for WebSocket connections
# Generate one with: openssl rand -hex 24
WEB_CHANNEL_TOKEN=

# Agent name shown in chat responses
ASSISTANT_NAME=Agent
```

**Step 5: Create .gitignore**

```
node_modules/
dist/
.env
*.tsbuildinfo
```

**Step 6: Create .npmrc**

```
shamefully-hoist=true
```

**Step 7: Install root dev dependencies**

Run: `cd /Users/kelliott/Metaplex/AI/UsefulAgents/014-agent-template && pnpm install -Dw typescript tsx @types/node`

**Step 8: Commit**

```bash
git init
git add -A
git commit -m "chore: initialize pnpm workspace with base config"
```

---

### Task 2: Shared Package — Types & Config

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/types/protocol.ts`
- Create: `packages/shared/src/types/agent.ts`
- Create: `packages/shared/src/config.ts`

**Step 1: Create packages/shared/package.json**

```json
{
  "name": "@metaplex-agent/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@metaplex-foundation/umi": "^1.1.0",
    "@metaplex-foundation/umi-bundle-defaults": "^1.1.0",
    "@metaplex-foundation/mpl-toolbox": "^1.0.0",
    "bs58": "^6.0.0",
    "dotenv": "^16.4.0",
    "zod": "^3.23.0"
  }
}
```

**Step 2: Create packages/shared/tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 3: Create packages/shared/src/config.ts**

This loads and validates all env vars.

```typescript
import { config } from 'dotenv';
import { resolve } from 'path';
import { z } from 'zod';

// Load .env from workspace root
config({ path: resolve(process.cwd(), '.env') });

const envSchema = z.object({
  AGENT_MODE: z.enum(['public', 'autonomous']).default('public'),
  LLM_MODEL: z.string().default('anthropic/claude-sonnet-4-5-20250929'),
  SOLANA_RPC_URL: z.string().default('https://api.devnet.solana.com'),
  AGENT_KEYPAIR: z.string().optional(),
  WEB_CHANNEL_PORT: z.coerce.number().default(3002),
  WEB_CHANNEL_TOKEN: z.string().min(1, 'WEB_CHANNEL_TOKEN is required'),
  ASSISTANT_NAME: z.string().default('Agent'),
});

export type EnvConfig = z.infer<typeof envSchema>;

let _config: EnvConfig | null = null;

export function getConfig(): EnvConfig {
  if (!_config) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      const errors = result.error.issues.map(
        (i) => `  ${i.path.join('.')}: ${i.message}`
      );
      throw new Error(
        `Invalid environment configuration:\n${errors.join('\n')}\n\nSee .env.example for required variables.`
      );
    }
    _config = result.data;
  }
  return _config;
}

export type AgentMode = 'public' | 'autonomous';
```

**Step 4: Create packages/shared/src/types/protocol.ts**

Full PlexChat protocol type definitions.

```typescript
// ============================================================================
// PlexChat WebSocket Protocol Types
// ============================================================================

// --- Client → Server Messages ---

export interface ClientChatMessage {
  type: 'message';
  content: string;
  sender_name?: string;
}

export interface ClientWalletConnect {
  type: 'wallet_connect';
  address: string;
}

export interface ClientWalletDisconnect {
  type: 'wallet_disconnect';
}

export type ClientMessage =
  | ClientChatMessage
  | ClientWalletConnect
  | ClientWalletDisconnect;

// --- Server → Client Messages ---

export interface ServerConnected {
  type: 'connected';
  jid: string;
}

export interface ServerChatMessage {
  type: 'message';
  content: string;
  sender: string;
}

export interface ServerTyping {
  type: 'typing';
  isTyping: boolean;
}

export interface ServerTransaction {
  type: 'transaction';
  transaction: string; // base64-encoded serialized Solana transaction
  message?: string;
  index?: number;
  total?: number;
}

export interface ServerWalletConnected {
  type: 'wallet_connected';
  address: string;
}

export interface ServerWalletDisconnected {
  type: 'wallet_disconnected';
}

export interface ServerError {
  type: 'error';
  error: string;
}

export type ServerMessage =
  | ServerConnected
  | ServerChatMessage
  | ServerTyping
  | ServerTransaction
  | ServerWalletConnected
  | ServerWalletDisconnected
  | ServerError;
```

**Step 5: Create packages/shared/src/types/agent.ts**

```typescript
import type { ServerTransaction } from './protocol.js';

/**
 * Interface for sending transactions to connected clients.
 * In public mode, the server injects a real implementation.
 * In autonomous mode, this is never called.
 */
export interface TransactionSender {
  sendTransaction(tx: ServerTransaction): void;
}

/**
 * Context passed to tools during execution.
 * Provides access to the wallet address and transaction sender.
 */
export interface AgentContext {
  walletAddress: string | null;
  transactionSender: TransactionSender | null;
  agentMode: 'public' | 'autonomous';
}
```

**Step 6: Create packages/shared/src/index.ts**

```typescript
export * from './types/protocol.js';
export * from './types/agent.js';
export * from './config.js';
```

**Step 7: Run pnpm install from root, verify typecheck**

Run: `cd /Users/kelliott/Metaplex/AI/UsefulAgents/014-agent-template && pnpm install && pnpm --filter @metaplex-agent/shared typecheck`

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: add shared package with PlexChat protocol types and config"
```

---

### Task 3: Shared Package — Umi Factory & Transaction Helpers

**Files:**
- Create: `packages/shared/src/umi.ts`
- Create: `packages/shared/src/transaction.ts`
- Modify: `packages/shared/src/index.ts`

**Step 1: Create packages/shared/src/umi.ts**

```typescript
import { createUmi as createUmiBase } from '@metaplex-foundation/umi-bundle-defaults';
import {
  createSignerFromKeypair,
  signerIdentity,
  type Umi,
} from '@metaplex-foundation/umi';
import { mplToolbox } from '@metaplex-foundation/mpl-toolbox';
import bs58 from 'bs58';
import { getConfig } from './config.js';

/**
 * Creates a configured Umi instance based on the current environment.
 *
 * - Always registers the mpl-toolbox plugin
 * - In autonomous mode: loads the agent keypair and sets it as identity/payer
 * - In public mode: no signer configured (transactions are sent to the frontend)
 */
export function createUmi(): Umi {
  const config = getConfig();
  const umi = createUmiBase(config.SOLANA_RPC_URL).use(mplToolbox());

  if (config.AGENT_MODE === 'autonomous') {
    if (!config.AGENT_KEYPAIR) {
      throw new Error(
        'AGENT_KEYPAIR is required in autonomous mode. Set it in your .env file.'
      );
    }
    const secretKey = bs58.decode(config.AGENT_KEYPAIR);
    const keypair = umi.eddsa.createKeypairFromSecretKey(secretKey);
    const signer = createSignerFromKeypair(umi, keypair);
    umi.use(signerIdentity(signer));
  }

  return umi;
}
```

**Step 2: Create packages/shared/src/transaction.ts**

```typescript
import {
  type Umi,
  type TransactionBuilder,
  type Signer,
  createNoopSigner,
  publicKey as toPublicKey,
} from '@metaplex-foundation/umi';
import { base64 } from '@metaplex-foundation/umi/serializers';
import { getConfig } from './config.js';
import type { TransactionSender, AgentContext } from './types/agent.js';

/**
 * Submits a transaction based on the agent mode:
 *
 * - **Public mode**: Serializes the transaction to base64 and sends it to the
 *   connected frontend wallet for signing via the TransactionSender.
 *
 * - **Autonomous mode**: Signs with the agent keypair and submits directly to
 *   the Solana network.
 *
 * @param umi - The configured Umi instance
 * @param builder - A TransactionBuilder with instructions ready to go
 * @param context - Agent context with wallet address and transaction sender
 * @param options - Optional message and multi-transaction index/total
 * @returns Transaction signature (autonomous mode) or "sent-to-wallet" (public mode)
 */
export async function submitOrSend(
  umi: Umi,
  builder: TransactionBuilder,
  context: AgentContext,
  options?: { message?: string; index?: number; total?: number }
): Promise<string> {
  const config = getConfig();

  if (config.AGENT_MODE === 'public') {
    if (!context.transactionSender) {
      throw new Error('No transaction sender available. Is the WebSocket server running?');
    }
    if (!context.walletAddress) {
      throw new Error('No wallet connected. Ask the user to connect their wallet first.');
    }

    // Use a noop signer for the user's wallet — they'll sign on the frontend
    const walletSigner = createNoopSigner(toPublicKey(context.walletAddress));

    // Build the transaction with the user as fee payer
    const tx = await builder
      .setFeePayer(walletSigner)
      .buildAndSign(umi);

    // Serialize to base64
    const serialized = umi.transactions.serialize(tx);
    const txBase64 = base64.deserialize(serialized)[0];

    // Send to frontend via WebSocket
    context.transactionSender.sendTransaction({
      type: 'transaction',
      transaction: txBase64,
      message: options?.message,
      index: options?.index,
      total: options?.total,
    });

    return 'sent-to-wallet';
  }

  // Autonomous mode: sign and submit
  const result = await builder.sendAndConfirm(umi);
  const sig = base64.deserialize(umi.transactions.serialize(
    // We need the signature bytes, extract from the result
    result.signature as unknown as Uint8Array
  ))[0];

  return typeof result.signature === 'string'
    ? result.signature
    : bs58Encode(result.signature);
}

function bs58Encode(bytes: Uint8Array): string {
  // Use base58 encoding for transaction signatures
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let result = '';
  let num = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  while (num > 0n) {
    result = ALPHABET[Number(num % 58n)] + result;
    num = num / 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) result = '1' + result;
    else break;
  }
  return result;
}
```

**Step 3: Update packages/shared/src/index.ts**

```typescript
export * from './types/protocol.js';
export * from './types/agent.js';
export * from './config.js';
export * from './umi.js';
export * from './transaction.js';
```

**Step 4: Verify typecheck**

Run: `cd /Users/kelliott/Metaplex/AI/UsefulAgents/014-agent-template && pnpm --filter @metaplex-agent/shared typecheck`

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Umi factory and transaction submit/send helper"
```

---

### Task 4: Core Package — Agent & Tools Setup

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/src/agent.ts`
- Create: `packages/core/src/tools/index.ts`

**Step 1: Create packages/core/package.json**

```json
{
  "name": "@metaplex-agent/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@mastra/core": "^1.24.0",
    "@metaplex-agent/shared": "workspace:*",
    "@metaplex-foundation/umi": "^1.1.0",
    "@metaplex-foundation/mpl-toolbox": "^1.0.0",
    "zod": "^3.23.0"
  }
}
```

**Step 2: Create packages/core/tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 3: Create packages/core/src/agent.ts**

```typescript
import { Agent } from '@mastra/core/agent';
import { getConfig } from '@metaplex-agent/shared';
import { tools } from './tools/index.js';

const SYSTEM_PROMPT = `You are a helpful Solana blockchain assistant. You help users interact with the Solana blockchain using your available tools.

You can:
- Check SOL balances for any wallet address
- View token holdings for any wallet
- Transfer SOL between wallets
- Transfer SPL tokens between wallets
- Look up transaction details

When the user has connected their wallet, use that address as the default for operations unless they specify a different address.

Always confirm transaction details with the user before executing transfers. Be clear about amounts, recipients, and any fees involved.

If the user asks you to do something you don't have a tool for, let them know what you can help with.`;

export function createAgent() {
  const config = getConfig();

  return new Agent({
    id: 'metaplex-agent',
    name: config.ASSISTANT_NAME,
    instructions: SYSTEM_PROMPT,
    model: config.LLM_MODEL,
    tools,
  });
}
```

**Step 4: Create packages/core/src/tools/index.ts (empty placeholder)**

```typescript
// Tools are registered here and exported as a record for the agent.
// Each tool is defined in its own file in this directory.

import type { Tool } from '@mastra/core/tools';

export const tools: Record<string, Tool> = {};
```

**Step 5: Create packages/core/src/index.ts**

```typescript
export { createAgent } from './agent.js';
export { tools } from './tools/index.js';
```

**Step 6: Run pnpm install, verify typecheck**

Run: `cd /Users/kelliott/Metaplex/AI/UsefulAgents/014-agent-template && pnpm install && pnpm --filter @metaplex-agent/core typecheck`

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: add core package with Mastra agent definition"
```

---

### Task 5: Core Package — getBalance Tool

**Files:**
- Create: `packages/core/src/tools/get-balance.ts`
- Modify: `packages/core/src/tools/index.ts`

**Step 1: Create packages/core/src/tools/get-balance.ts**

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-agent/shared';

export const getBalance = createTool({
  id: 'get-balance',
  description:
    'Get the SOL balance of a Solana wallet address. Returns the balance in SOL.',
  inputSchema: z.object({
    address: z
      .string()
      .describe('The Solana wallet address (base58-encoded public key)'),
  }),
  outputSchema: z.object({
    address: z.string(),
    balanceSol: z.number(),
    balanceLamports: z.string(),
  }),
  execute: async ({ address }) => {
    const umi = createUmi();
    const pubkey = publicKey(address);
    const balance = await umi.rpc.getBalance(pubkey);
    const lamports = balance.basisPoints.toString();
    const sol = Number(balance.basisPoints) / 1_000_000_000;

    return {
      address,
      balanceSol: sol,
      balanceLamports: lamports,
    };
  },
});
```

**Step 2: Update packages/core/src/tools/index.ts**

```typescript
import { getBalance } from './get-balance.js';

export const tools = {
  getBalance,
};
```

**Step 3: Verify typecheck**

Run: `cd /Users/kelliott/Metaplex/AI/UsefulAgents/014-agent-template && pnpm --filter @metaplex-agent/core typecheck`

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add getBalance tool"
```

---

### Task 6: Core Package — getTokenBalances Tool

**Files:**
- Create: `packages/core/src/tools/get-token-balances.ts`
- Modify: `packages/core/src/tools/index.ts`

**Step 1: Create packages/core/src/tools/get-token-balances.ts**

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey } from '@metaplex-foundation/umi';
import {
  fetchAllTokenByOwner,
  fetchMint,
} from '@metaplex-foundation/mpl-toolbox';
import { createUmi } from '@metaplex-agent/shared';

export const getTokenBalances = createTool({
  id: 'get-token-balances',
  description:
    'Get all SPL token holdings for a Solana wallet. Returns mint addresses, raw amounts, and human-readable amounts with decimals.',
  inputSchema: z.object({
    address: z
      .string()
      .describe('The Solana wallet address (base58-encoded public key)'),
  }),
  outputSchema: z.object({
    address: z.string(),
    tokens: z.array(
      z.object({
        mint: z.string(),
        rawAmount: z.string(),
        decimals: z.number(),
        uiAmount: z.number(),
      })
    ),
  }),
  execute: async ({ address }) => {
    const umi = createUmi();
    const owner = publicKey(address);
    const tokenAccounts = await fetchAllTokenByOwner(umi, owner);

    const tokens = await Promise.all(
      tokenAccounts
        .filter((ta) => ta.amount > 0n)
        .map(async (ta) => {
          const mintAccount = await fetchMint(umi, ta.mint);
          const uiAmount =
            Number(ta.amount) / Math.pow(10, mintAccount.decimals);
          return {
            mint: ta.mint.toString(),
            rawAmount: ta.amount.toString(),
            decimals: mintAccount.decimals,
            uiAmount,
          };
        })
    );

    return { address, tokens };
  },
});
```

**Step 2: Update packages/core/src/tools/index.ts**

```typescript
import { getBalance } from './get-balance.js';
import { getTokenBalances } from './get-token-balances.js';

export const tools = {
  getBalance,
  getTokenBalances,
};
```

**Step 3: Verify typecheck**

Run: `pnpm --filter @metaplex-agent/core typecheck`

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add getTokenBalances tool"
```

---

### Task 7: Core Package — transferSol Tool

**Files:**
- Create: `packages/core/src/tools/transfer-sol.ts`
- Modify: `packages/core/src/tools/index.ts`

**Step 1: Create packages/core/src/tools/transfer-sol.ts**

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey, sol } from '@metaplex-foundation/umi';
import { transferSol as transferSolIx } from '@metaplex-foundation/mpl-toolbox';
import {
  createUmi,
  submitOrSend,
  type AgentContext,
} from '@metaplex-agent/shared';

export const transferSol = createTool({
  id: 'transfer-sol',
  description:
    'Transfer SOL from the connected wallet (public mode) or agent wallet (autonomous mode) to a destination address.',
  inputSchema: z.object({
    destination: z
      .string()
      .describe('The recipient Solana wallet address'),
    amount: z
      .number()
      .positive()
      .describe('Amount of SOL to transfer'),
  }),
  outputSchema: z.object({
    status: z.string(),
    signature: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ destination, amount }, { requestContext }) => {
    const context = requestContext as unknown as AgentContext;
    const umi = createUmi();

    const builder = transferSolIx(umi, {
      source: umi.identity,
      destination: publicKey(destination),
      amount: sol(amount),
    });

    const result = await submitOrSend(umi, builder, context, {
      message: `Transfer ${amount} SOL to ${destination}`,
    });

    if (result === 'sent-to-wallet') {
      return {
        status: 'pending',
        message: `Transaction sent to your wallet for signing. Please approve the transfer of ${amount} SOL to ${destination}.`,
      };
    }

    return {
      status: 'confirmed',
      signature: result,
      message: `Successfully transferred ${amount} SOL to ${destination}. Signature: ${result}`,
    };
  },
});
```

**Step 2: Update packages/core/src/tools/index.ts**

```typescript
import { getBalance } from './get-balance.js';
import { getTokenBalances } from './get-token-balances.js';
import { transferSol } from './transfer-sol.js';

export const tools = {
  getBalance,
  getTokenBalances,
  transferSol,
};
```

**Step 3: Verify typecheck**

Run: `pnpm --filter @metaplex-agent/core typecheck`

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add transferSol tool"
```

---

### Task 8: Core Package — transferToken Tool

**Files:**
- Create: `packages/core/src/tools/transfer-token.ts`
- Modify: `packages/core/src/tools/index.ts`

**Step 1: Create packages/core/src/tools/transfer-token.ts**

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey, transactionBuilder } from '@metaplex-foundation/umi';
import {
  transferTokens,
  findAssociatedTokenPda,
  createTokenIfMissing,
  fetchMint,
} from '@metaplex-foundation/mpl-toolbox';
import {
  createUmi,
  submitOrSend,
  type AgentContext,
} from '@metaplex-agent/shared';

export const transferToken = createTool({
  id: 'transfer-token',
  description:
    'Transfer SPL tokens from the connected wallet (public mode) or agent wallet (autonomous mode) to a destination address. Automatically creates the destination token account if needed.',
  inputSchema: z.object({
    mint: z.string().describe('The token mint address'),
    destination: z.string().describe('The recipient wallet address'),
    amount: z
      .number()
      .positive()
      .describe(
        'Amount of tokens to transfer in human-readable units (e.g., 100 for 100 tokens)'
      ),
  }),
  outputSchema: z.object({
    status: z.string(),
    signature: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ mint, destination, amount }, { requestContext }) => {
    const context = requestContext as unknown as AgentContext;
    const umi = createUmi();

    const mintPk = publicKey(mint);
    const destOwner = publicKey(destination);
    const sourceOwner = umi.identity.publicKey;

    // Fetch mint to get decimals for converting human-readable amount
    const mintAccount = await fetchMint(umi, mintPk);
    const rawAmount = BigInt(
      Math.round(amount * Math.pow(10, mintAccount.decimals))
    );

    const [sourceAta] = findAssociatedTokenPda(umi, {
      mint: mintPk,
      owner: sourceOwner,
    });
    const [destinationAta] = findAssociatedTokenPda(umi, {
      mint: mintPk,
      owner: destOwner,
    });

    const builder = transactionBuilder()
      .add(createTokenIfMissing(umi, { mint: mintPk, owner: destOwner }))
      .add(
        transferTokens(umi, {
          source: sourceAta,
          destination: destinationAta,
          authority: umi.identity,
          amount: rawAmount,
        })
      );

    const result = await submitOrSend(umi, builder, context, {
      message: `Transfer ${amount} tokens (${mint}) to ${destination}`,
    });

    if (result === 'sent-to-wallet') {
      return {
        status: 'pending',
        message: `Transaction sent to your wallet for signing. Please approve the transfer of ${amount} tokens to ${destination}.`,
      };
    }

    return {
      status: 'confirmed',
      signature: result,
      message: `Successfully transferred ${amount} tokens to ${destination}. Signature: ${result}`,
    };
  },
});
```

**Step 2: Update packages/core/src/tools/index.ts**

```typescript
import { getBalance } from './get-balance.js';
import { getTokenBalances } from './get-token-balances.js';
import { transferSol } from './transfer-sol.js';
import { transferToken } from './transfer-token.js';

export const tools = {
  getBalance,
  getTokenBalances,
  transferSol,
  transferToken,
};
```

**Step 3: Verify typecheck**

Run: `pnpm --filter @metaplex-agent/core typecheck`

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add transferToken tool"
```

---

### Task 9: Core Package — getTransaction Tool

**Files:**
- Create: `packages/core/src/tools/get-transaction.ts`
- Modify: `packages/core/src/tools/index.ts`

**Step 1: Create packages/core/src/tools/get-transaction.ts**

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createUmi } from '@metaplex-agent/shared';

export const getTransaction = createTool({
  id: 'get-transaction',
  description:
    'Look up a Solana transaction by its signature. Returns transaction status, block time, and error information if any.',
  inputSchema: z.object({
    signature: z
      .string()
      .describe('The transaction signature (base58-encoded)'),
  }),
  outputSchema: z.object({
    signature: z.string(),
    found: z.boolean(),
    slot: z.number().optional(),
    blockTime: z.number().nullable().optional(),
    err: z.any().optional(),
  }),
  execute: async ({ signature }) => {
    const umi = createUmi();

    // Use getSignatureStatuses to check transaction status
    // Note: Umi doesn't have a direct getTransaction — we use the RPC
    const [status] = await umi.rpc.call<
      [{ slot: number; confirmationStatus: string; err: unknown } | null]
    >('getSignatureStatuses', [[signature]], {
      searchTransactionHistory: true,
    });

    if (!status) {
      return {
        signature,
        found: false,
      };
    }

    return {
      signature,
      found: true,
      slot: status.slot,
      err: status.err,
    };
  },
});
```

**Step 2: Update packages/core/src/tools/index.ts**

```typescript
import { getBalance } from './get-balance.js';
import { getTokenBalances } from './get-token-balances.js';
import { transferSol } from './transfer-sol.js';
import { transferToken } from './transfer-token.js';
import { getTransaction } from './get-transaction.js';

export const tools = {
  getBalance,
  getTokenBalances,
  transferSol,
  transferToken,
  getTransaction,
};
```

**Step 3: Verify typecheck**

Run: `pnpm --filter @metaplex-agent/core typecheck`

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add getTransaction tool"
```

---

### Task 10: Server Package — WebSocket Server

**Files:**
- Create: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`
- Create: `packages/server/src/index.ts`
- Create: `packages/server/src/websocket.ts`

**Step 1: Create packages/server/package.json**

```json
{
  "name": "@metaplex-agent/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@metaplex-agent/core": "workspace:*",
    "@metaplex-agent/shared": "workspace:*",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.0",
    "tsx": "^4.19.0"
  }
}
```

**Step 2: Create packages/server/tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 3: Create packages/server/src/websocket.ts**

The full PlexChat protocol server implementation.

```typescript
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type IncomingMessage } from 'http';
import {
  getConfig,
  type ServerTransaction,
  type TransactionSender,
  type AgentContext,
  type ClientMessage,
} from '@metaplex-agent/shared';
import { createAgent } from '@metaplex-agent/core';

/**
 * PlexChat WebSocket Server
 *
 * Implements the PlexChat protocol for real-time communication between
 * web frontends and the Mastra agent. Handles authentication, message
 * routing, wallet state, typing indicators, and transaction bridging.
 */
export class PlexChatServer {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private walletAddress: string | null = null;
  private agent: ReturnType<typeof createAgent>;

  constructor() {
    this.agent = createAgent();
  }

  /**
   * Start the WebSocket server on the configured port.
   */
  start(): void {
    const config = getConfig();
    const port = config.WEB_CHANNEL_PORT;

    const server = createServer();

    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    server.listen(port, () => {
      console.log(`PlexChat WebSocket server running on ws://localhost:${port}`);
      console.log(`Agent mode: ${config.AGENT_MODE}`);
      console.log(`Agent name: ${config.ASSISTANT_NAME}`);
    });
  }

  /**
   * Handle a new WebSocket connection. Validates the auth token
   * and sets up message handlers.
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const config = getConfig();

    // --- Authentication ---
    const token = this.extractToken(req);
    if (token !== config.WEB_CHANNEL_TOKEN) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    // --- Track client ---
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));

    // --- Send connected message ---
    this.send(ws, { type: 'connected', jid: 'web:default' });

    // --- Message handler ---
    ws.on('message', (data: Buffer) => {
      this.handleMessage(ws, data);
    });
  }

  /**
   * Extract the auth token from the request (query param or header).
   */
  private extractToken(req: IncomingMessage): string | null {
    // Try query parameter first
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const queryToken = url.searchParams.get('token');
    if (queryToken) return queryToken;

    // Try Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    return null;
  }

  /**
   * Handle an incoming WebSocket message.
   */
  private async handleMessage(ws: WebSocket, data: Buffer): Promise<void> {
    // --- Parse JSON ---
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.send(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'message':
        await this.handleChatMessage(ws, msg.content, msg.sender_name);
        break;
      case 'wallet_connect':
        this.handleWalletConnect(ws, msg.address);
        break;
      case 'wallet_disconnect':
        this.handleWalletDisconnect();
        break;
      default:
        this.send(ws, {
          type: 'error',
          error: `Unknown message type: ${(msg as { type: string }).type}`,
        });
    }
  }

  /**
   * Handle a chat message: invoke the Mastra agent and stream the response.
   */
  private async handleChatMessage(
    ws: WebSocket,
    content: string | undefined,
    senderName?: string
  ): Promise<void> {
    if (!content) {
      this.send(ws, {
        type: 'error',
        error: 'Expected { type: "message", content: "..." }',
      });
      return;
    }

    if (!content.trim()) return; // silently ignore empty

    const config = getConfig();

    // --- Typing indicator ON ---
    this.broadcast({ type: 'typing', isTyping: true });

    try {
      // Build the agent context with wallet and transaction sender
      const transactionSender: TransactionSender = {
        sendTransaction: (tx: ServerTransaction) => this.broadcast(tx),
      };

      const agentContext: AgentContext = {
        walletAddress: this.walletAddress,
        transactionSender,
        agentMode: config.AGENT_MODE,
      };

      // Prepend wallet context to the message if available
      let fullMessage = content;
      if (this.walletAddress) {
        fullMessage = `[User wallet: ${this.walletAddress}] ${content}`;
      }

      // Invoke the agent
      const response = await this.agent.generate(fullMessage, {
        requestContext: agentContext as Record<string, unknown>,
        maxSteps: 10,
      });

      // Send the response
      this.broadcast({
        type: 'message',
        content: response.text,
        sender: config.ASSISTANT_NAME,
      });
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : 'An unknown error occurred';
      this.broadcast({
        type: 'message',
        content: `I encountered an error: ${errorMsg}`,
        sender: config.ASSISTANT_NAME,
      });
    } finally {
      // --- Typing indicator OFF ---
      this.broadcast({ type: 'typing', isTyping: false });
    }
  }

  /**
   * Handle wallet_connect: store address and broadcast confirmation.
   */
  private handleWalletConnect(ws: WebSocket, address: string | undefined): void {
    if (!address?.trim()) {
      this.send(ws, {
        type: 'error',
        error: 'wallet_connect requires a non-empty address string',
      });
      return;
    }

    this.walletAddress = address;
    this.broadcast({ type: 'wallet_connected', address });
  }

  /**
   * Handle wallet_disconnect: clear address and broadcast.
   */
  private handleWalletDisconnect(): void {
    this.walletAddress = null;
    this.broadcast({ type: 'wallet_disconnected' });
  }

  /**
   * Send a message to a single client.
   */
  private send(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Broadcast a message to all connected clients.
   */
  private broadcast(msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }
}
```

**Step 4: Create packages/server/src/index.ts**

```typescript
import { PlexChatServer } from './websocket.js';

const server = new PlexChatServer();
server.start();
```

**Step 5: Run pnpm install, verify typecheck**

Run: `cd /Users/kelliott/Metaplex/AI/UsefulAgents/014-agent-template && pnpm install && pnpm --filter @metaplex-agent/server typecheck`

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add server package with PlexChat WebSocket protocol"
```

---

### Task 11: Documentation — Root README

**Files:**
- Create: `README.md`

Write a comprehensive root README covering:
- What this template is and who it's for
- Architecture diagram (text-based)
- Quick start (clone, install, configure, run)
- Agent modes explained (public vs autonomous)
- Environment variable reference table
- Project structure with descriptions
- How to add new tools (brief guide, link to core README)
- How to customize the agent prompt
- PlexChat protocol overview (link to WEBSOCKET_PROTOCOL.md)
- Deployment notes

**Commit:**

```bash
git add README.md
git commit -m "docs: add root README with quickstart and architecture"
```

---

### Task 12: Documentation — Package READMEs

**Files:**
- Create: `packages/core/README.md`
- Create: `packages/server/README.md`
- Create: `packages/shared/README.md`

**packages/core/README.md** — Cover:
- How to modify the system prompt
- How to add a new tool (step-by-step with code template)
- Tool anatomy (inputSchema, outputSchema, execute)
- Using the transaction helpers in tools
- Configuring the LLM provider

**packages/server/README.md** — Cover:
- Server configuration
- Protocol message reference (summary table, link to full spec)
- How the transaction bridge works
- Running in dev vs production
- Deployment considerations

**packages/shared/README.md** — Cover:
- Umi factory usage
- Transaction helpers (submitOrSend)
- Protocol types reference
- Configuration system
- Adding new shared utilities

**Commit:**

```bash
git add packages/*/README.md
git commit -m "docs: add package-level READMEs"
```

---

### Task 13: Final Polish

**Files:**
- Review all files for consistency
- Verify `pnpm install && pnpm build` succeeds
- Verify `pnpm typecheck` passes across all packages

**Step 1: Run full build from root**

Run: `cd /Users/kelliott/Metaplex/AI/UsefulAgents/014-agent-template && pnpm install && pnpm build`

Expected: All three packages compile successfully.

**Step 2: Run typecheck**

Run: `pnpm typecheck`

Expected: No type errors.

**Step 3: Fix any issues found**

Address compilation errors, missing types, or broken imports.

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: final polish and verify full build"
```
