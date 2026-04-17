# Autonomous Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a 1-to-1 autonomous agent with on-chain registration, token launch, and DeFi treasury management alongside the existing public agent.

**Architecture:** Two agent definitions (`agent-public.ts`, `agent-autonomous.ts`) selected by a factory based on `AGENT_MODE`. Tools are organized into `shared/`, `public/`, and `autonomous/` subdirectories. All autonomous fund operations route through Core Execute, using the asset signer PDA as the agent's operational wallet.

**Tech Stack:** Mastra (`@mastra/core`), Metaplex Umi, `@metaplex-foundation/mpl-agent-registry`, `@metaplex-foundation/mpl-core`, `@metaplex-foundation/genesis`, Jupiter Swap API v1.

**Design doc:** `docs/plans/2026-04-14-autonomous-agent-design.md`

---

### Task 1: Add new dependencies

Install the new packages needed for agent registration, Core Execute, and token launch.

**Files:**
- Modify: `packages/shared/package.json`
- Modify: `packages/core/package.json`

**Step 1: Add dependencies to shared package**

```bash
cd /Users/kelliott/Metaplex/AI/UsefulAgents/014-agent-template
pnpm --filter @metaplex-agent/shared add @metaplex-foundation/mpl-core @metaplex-foundation/genesis
```

**Step 2: Add dependencies to core package**

```bash
pnpm --filter @metaplex-agent/core add @metaplex-foundation/mpl-agent-registry @metaplex-foundation/mpl-core
```

**Step 3: Verify install**

```bash
pnpm install
pnpm --filter @metaplex-agent/shared typecheck
pnpm --filter @metaplex-agent/core typecheck
```

Expected: Clean install, no type errors.

**Step 4: Commit**

```bash
git add packages/shared/package.json packages/core/package.json pnpm-lock.yaml
git commit -m "chore: add mpl-agent-registry, mpl-core, genesis dependencies"
```

---

### Task 2: Update config and AgentContext types

Add `AGENT_ASSET_ADDRESS` and `AGENT_TOKEN_MINT` to the env schema and the `AgentContext` type so tools can access them via RequestContext.

**Files:**
- Modify: `packages/shared/src/config.ts`
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `packages/shared/src/.env.example` (workspace root `.env.example`)

**Step 1: Update env schema**

In `packages/shared/src/config.ts`, add two optional fields to the `envSchema` object after `JUPITER_API_KEY`:

```typescript
AGENT_ASSET_ADDRESS: z.string().optional(),
AGENT_TOKEN_MINT: z.string().optional(),
```

**Step 2: Update AgentContext type**

In `packages/shared/src/types/agent.ts`, add two fields to the `AgentContext` interface:

```typescript
export interface AgentContext {
  walletAddress: string | null;
  transactionSender: TransactionSender | null;
  agentMode: 'public' | 'autonomous';
  agentAssetAddress: string | null;
  agentTokenMint: string | null;
}
```

**Step 3: Update .env.example**

Add to the workspace root `.env.example` at the end of the Solana Configuration section:

```
# Agent asset address from the Metaplex Agent Registry (autonomous mode only)
# Set this after your agent registers itself for the first time
AGENT_ASSET_ADDRESS=

# Agent token mint address (autonomous mode only)
# Set this after your agent launches its token
AGENT_TOKEN_MINT=
```

**Step 4: Update RequestContext in websocket.ts**

In `packages/server/src/websocket.ts`, update the RequestContext constructor to include the new fields. Find the `requestContext` construction (around line 159) and add two entries:

```typescript
const requestContext = new RequestContext<AgentContext>([
  ['walletAddress', this.walletAddress],
  ['transactionSender', transactionSender],
  ['agentMode', config.AGENT_MODE],
  ['agentAssetAddress', config.AGENT_ASSET_ADDRESS ?? null],
  ['agentTokenMint', config.AGENT_TOKEN_MINT ?? null],
]);
```

**Step 5: Fix any existing tools that construct AgentContext**

In `packages/core/src/tools/transfer-sol.ts` and `packages/core/src/tools/transfer-token.ts`, the `context` object needs the new fields. Update the context construction pattern in both files:

```typescript
const context: AgentContext = {
  walletAddress: ctx?.get('walletAddress') ?? null,
  transactionSender: ctx?.get('transactionSender') ?? null,
  agentMode: ctx?.get('agentMode') ?? 'public',
  agentAssetAddress: ctx?.get('agentAssetAddress') ?? null,
  agentTokenMint: ctx?.get('agentTokenMint') ?? null,
};
```

**Step 6: Typecheck**

```bash
pnpm --filter @metaplex-agent/shared typecheck
pnpm --filter @metaplex-agent/core typecheck
pnpm --filter @metaplex-agent/server typecheck
```

Expected: No type errors.

**Step 7: Commit**

```bash
git add packages/shared/src/config.ts packages/shared/src/types/agent.ts .env.example packages/server/src/websocket.ts packages/core/src/tools/transfer-sol.ts packages/core/src/tools/transfer-token.ts
git commit -m "feat: add agentAssetAddress and agentTokenMint to config and context"
```

---

### Task 3: Create the Core Execute helper

Build the `executeAsAgent` helper that wraps arbitrary instructions in a Core Execute call, so the asset signer PDA signs the inner instructions via CPI.

**Files:**
- Create: `packages/shared/src/execute.ts`
- Modify: `packages/shared/src/index.ts`

**Step 1: Create execute.ts**

Create `packages/shared/src/execute.ts`:

```typescript
import {
  type Umi,
  type TransactionBuilder,
  type PublicKey,
} from '@metaplex-foundation/umi';
import {
  execute,
  fetchAsset,
  findAssetSignerPda,
} from '@metaplex-foundation/mpl-core';
import bs58 from 'bs58';

/**
 * Wraps instructions in a Core Execute call so the asset signer PDA
 * signs the inner instructions via CPI. The umi.identity (agent keypair)
 * must be the asset owner.
 *
 * @param umi - Configured Umi instance with agent keypair as identity
 * @param agentAssetAddress - The agent's MPL Core asset address
 * @param instructions - TransactionBuilder with instructions using the PDA as signer
 * @returns Base58-encoded transaction signature
 */
export async function executeAsAgent(
  umi: Umi,
  agentAssetAddress: PublicKey,
  instructions: TransactionBuilder
): Promise<string> {
  const asset = await fetchAsset(umi, agentAssetAddress);

  const tx = execute(umi, {
    asset,
    instructions,
  });

  const result = await tx.sendAndConfirm(umi);
  return bs58.encode(result.signature);
}

/**
 * Derives the asset signer PDA for a given agent asset.
 * This PDA is the agent's operational wallet — it holds funds
 * and signs instructions via Core Execute CPI.
 */
export function getAgentPda(umi: Umi, agentAssetAddress: PublicKey): PublicKey {
  return findAssetSignerPda(umi, { asset: agentAssetAddress })[0];
}
```

**Step 2: Export from shared index**

Add to `packages/shared/src/index.ts`:

```typescript
export * from './execute.js';
```

**Step 3: Typecheck**

```bash
pnpm --filter @metaplex-agent/shared typecheck
```

Expected: No type errors.

**Step 4: Commit**

```bash
git add packages/shared/src/execute.ts packages/shared/src/index.ts
git commit -m "feat: add Core Execute helper (executeAsAgent, getAgentPda)"
```

---

### Task 4: Create the Jupiter swap helper

Build the shared Jupiter swap utility that gets a quote and builds swap instructions. This returns a serialized transaction that autonomous tools will deserialize and wrap in `executeAsAgent`.

**Files:**
- Create: `packages/shared/src/jupiter.ts`
- Modify: `packages/shared/src/index.ts`

**Step 1: Create jupiter.ts**

Create `packages/shared/src/jupiter.ts`:

```typescript
import {
  type Umi,
  type PublicKey,
} from '@metaplex-foundation/umi';
import bs58 from 'bs58';
import { getConfig } from './config.js';
import { executeAsAgent } from './execute.js';

export interface SwapParams {
  /** The wallet address that holds the input tokens (the agent PDA) */
  walletAddress: string;
  /** Input token mint address */
  inputMint: string;
  /** Output token mint address */
  outputMint: string;
  /** Amount in smallest unit (lamports for SOL, base units for tokens) */
  amount: string;
  /** Slippage tolerance in basis points (default 50 = 0.5%) */
  slippageBps?: number;
}

export interface SwapResult {
  signature: string;
  inputAmount: string;
  outputAmount: string;
  priceImpact: string;
}

interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: unknown[];
  [key: string]: unknown;
}

interface SwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
}

const JUPITER_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_URL = 'https://api.jup.ag/swap/v1/swap';

/**
 * Get a swap quote from Jupiter.
 */
export async function getSwapQuote(params: SwapParams): Promise<QuoteResponse> {
  const config = getConfig();
  const url = new URL(JUPITER_QUOTE_URL);
  url.searchParams.set('inputMint', params.inputMint);
  url.searchParams.set('outputMint', params.outputMint);
  url.searchParams.set('amount', params.amount);
  url.searchParams.set('slippageBps', String(params.slippageBps ?? 50));

  const headers: Record<string, string> = {};
  if (config.JUPITER_API_KEY) {
    headers['x-api-key'] = config.JUPITER_API_KEY;
  }

  const response = await fetch(url.toString(), { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Jupiter quote failed (${response.status}): ${body}`);
  }

  return response.json() as Promise<QuoteResponse>;
}

/**
 * Get a serialized swap transaction from Jupiter.
 * Returns a base64-encoded unsigned transaction.
 */
export async function getSwapTransaction(
  walletAddress: string,
  quoteResponse: QuoteResponse
): Promise<SwapResponse> {
  const config = getConfig();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.JUPITER_API_KEY) {
    headers['x-api-key'] = config.JUPITER_API_KEY;
  }

  const response = await fetch(JUPITER_SWAP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: walletAddress,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Jupiter swap failed (${response.status}): ${body}`);
  }

  return response.json() as Promise<SwapResponse>;
}

/**
 * Execute a token swap via Jupiter, routed through Core Execute
 * so the agent's PDA signs the swap transaction.
 *
 * @param umi - Configured Umi instance with agent keypair as identity
 * @param agentAssetAddress - The agent's MPL Core asset address
 * @param params - Swap parameters (walletAddress should be the agent PDA)
 * @returns Swap result with signature and amounts
 */
export async function executeSwap(
  umi: Umi,
  agentAssetAddress: PublicKey,
  params: SwapParams
): Promise<SwapResult> {
  // 1. Get quote
  const quote = await getSwapQuote(params);

  // 2. Get serialized transaction
  const { swapTransaction } = await getSwapTransaction(
    params.walletAddress,
    quote
  );

  // 3. Deserialize the transaction
  const txBytes = Buffer.from(swapTransaction, 'base64');
  const transaction = umi.transactions.deserialize(txBytes);

  // 4. Sign with the agent keypair and submit
  // Note: Jupiter returns a full transaction with the PDA as signer.
  // We sign it with umi.identity (the asset owner) and the Core Execute
  // program validates ownership and lets the PDA sign via CPI.
  const signedTx = await umi.identity.signTransaction(transaction);
  const signature = await umi.rpc.sendTransaction(signedTx);
  const signatureStr = bs58.encode(signature);

  // 5. Confirm
  const latestBlockhash = await umi.rpc.getLatestBlockhash();
  await umi.rpc.confirmTransaction(signature, {
    strategy: {
      type: 'blockhash',
      ...latestBlockhash,
    },
  });

  return {
    signature: signatureStr,
    inputAmount: quote.inAmount,
    outputAmount: quote.outAmount,
    priceImpact: quote.priceImpactPct,
  };
}

/** Well-known SOL mint address */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
```

**Step 2: Export from shared index**

Add to `packages/shared/src/index.ts`:

```typescript
export * from './jupiter.js';
```

**Step 3: Typecheck**

```bash
pnpm --filter @metaplex-agent/shared typecheck
```

Expected: No type errors. If there are Umi type mismatches with the transaction signing flow, we may need to adjust. The core pattern is correct but the exact Umi transaction API may need tweaking during implementation.

**Step 4: Commit**

```bash
git add packages/shared/src/jupiter.ts packages/shared/src/index.ts
git commit -m "feat: add Jupiter swap helper (quote, swap, executeSwap)"
```

---

### Task 5: Reorganize tools into subdirectories

Move existing tools into `shared/` and `public/` subdirectories. Update the tools index to export categorized tool sets.

**Files:**
- Move: `packages/core/src/tools/get-balance.ts` → `packages/core/src/tools/shared/get-balance.ts`
- Move: `packages/core/src/tools/get-token-balances.ts` → `packages/core/src/tools/shared/get-token-balances.ts`
- Move: `packages/core/src/tools/get-transaction.ts` → `packages/core/src/tools/shared/get-transaction.ts`
- Move: `packages/core/src/tools/get-token-price.ts` → `packages/core/src/tools/shared/get-token-price.ts`
- Move: `packages/core/src/tools/get-token-metadata.ts` → `packages/core/src/tools/shared/get-token-metadata.ts`
- Move: `packages/core/src/tools/sleep.ts` → `packages/core/src/tools/shared/sleep.ts`
- Move: `packages/core/src/tools/transfer-sol.ts` → `packages/core/src/tools/public/transfer-sol.ts`
- Move: `packages/core/src/tools/transfer-token.ts` → `packages/core/src/tools/public/transfer-token.ts`
- Create: `packages/core/src/tools/shared/index.ts`
- Create: `packages/core/src/tools/public/index.ts`
- Modify: `packages/core/src/tools/index.ts`

**Step 1: Create directories and move files**

```bash
cd /Users/kelliott/Metaplex/AI/UsefulAgents/014-agent-template
mkdir -p packages/core/src/tools/shared
mkdir -p packages/core/src/tools/public
mkdir -p packages/core/src/tools/autonomous

# Move shared tools
mv packages/core/src/tools/get-balance.ts packages/core/src/tools/shared/
mv packages/core/src/tools/get-token-balances.ts packages/core/src/tools/shared/
mv packages/core/src/tools/get-transaction.ts packages/core/src/tools/shared/
mv packages/core/src/tools/get-token-price.ts packages/core/src/tools/shared/
mv packages/core/src/tools/get-token-metadata.ts packages/core/src/tools/shared/
mv packages/core/src/tools/sleep.ts packages/core/src/tools/shared/

# Move public-only tools
mv packages/core/src/tools/transfer-sol.ts packages/core/src/tools/public/
mv packages/core/src/tools/transfer-token.ts packages/core/src/tools/public/
```

**Step 2: Create shared/index.ts**

Create `packages/core/src/tools/shared/index.ts`:

```typescript
import { getBalance } from './get-balance.js';
import { getTokenBalances } from './get-token-balances.js';
import { getTransaction } from './get-transaction.js';
import { getTokenPrice } from './get-token-price.js';
import { getTokenMetadata } from './get-token-metadata.js';
import { sleep } from './sleep.js';

export const sharedTools = {
  getBalance,
  getTokenBalances,
  getTransaction,
  getTokenPrice,
  getTokenMetadata,
  sleep,
};

export { getBalance, getTokenBalances, getTransaction, getTokenPrice, getTokenMetadata, sleep };
```

**Step 3: Create public/index.ts**

Create `packages/core/src/tools/public/index.ts`:

```typescript
import { transferSol } from './transfer-sol.js';
import { transferToken } from './transfer-token.js';

export const publicTools = {
  transferSol,
  transferToken,
};

export { transferSol, transferToken };
```

**Step 4: Update tools/index.ts**

Replace `packages/core/src/tools/index.ts` with:

```typescript
import { sharedTools } from './shared/index.js';
import { publicTools } from './public/index.js';

export const publicAgentTools = {
  ...sharedTools,
  ...publicTools,
};

export const sharedToolNames = Object.keys(sharedTools);
export const publicToolNames = Object.keys(publicAgentTools);

// Re-export for backward compatibility (server imports toolNames)
export const tools = publicAgentTools;
export const toolNames = publicToolNames;
```

**Step 5: Typecheck**

```bash
pnpm --filter @metaplex-agent/core typecheck
```

Expected: No type errors. The import paths inside the moved tool files don't need changing because they use package imports (`@metaplex-agent/shared`, `@mastra/core/tools`) not relative paths.

**Step 6: Commit**

```bash
git add packages/core/src/tools/
git commit -m "refactor: reorganize tools into shared/ and public/ subdirectories"
```

---

### Task 6: Split agent into public and autonomous definitions

Rename `agent.ts` to `agent-public.ts`, create `agent-autonomous.ts` with the autonomous system prompt, and create `create-agent.ts` as the factory.

**Files:**
- Rename: `packages/core/src/agent.ts` → `packages/core/src/agent-public.ts`
- Create: `packages/core/src/agent-autonomous.ts`
- Create: `packages/core/src/create-agent.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Rename agent.ts to agent-public.ts**

```bash
mv packages/core/src/agent.ts packages/core/src/agent-public.ts
```

Update the import in `agent-public.ts` to use the new tools path. Change:
```typescript
import { tools } from './tools/index.js';
```
to:
```typescript
import { publicAgentTools } from './tools/index.js';
```

And update the Agent constructor to use `publicAgentTools`:
```typescript
export function createPublicAgent() {
  const config = getConfig();

  return new Agent({
    id: 'metaplex-agent-public',
    name: config.ASSISTANT_NAME,
    instructions: SYSTEM_PROMPT,
    model: config.LLM_MODEL,
    tools: publicAgentTools,
  });
}
```

Also rename `createAgent` to `createPublicAgent`.

**Step 2: Create agent-autonomous.ts**

Create `packages/core/src/agent-autonomous.ts`:

```typescript
import { Agent } from '@mastra/core/agent';
import { getConfig } from '@metaplex-agent/shared';
import { sharedTools } from './tools/shared/index.js';
import { autonomousTools } from './tools/autonomous/index.js';

const SYSTEM_PROMPT = `You are an autonomous Solana agent with your own wallet and on-chain identity. You operate independently, managing your own funds and executing transactions on your own behalf.

You can:
- Check your own balances (SOL and tokens)
- Look up transaction details
- Get current USD prices for any Solana token
- Get token metadata (name, symbol, image)
- Register yourself on the Metaplex Agent Registry
- Delegate execution authority to your keypair
- Launch your own agent token
- Swap tokens via Jupiter DEX
- Buy back your own token (SOL → your token)
- Sell your own token allocation (your token → SOL)
- Sleep/pause for a specified duration (for monitoring loops)

## Self-Registration

When you first start or when asked to set up:
1. Use register-agent to mint yourself on the Metaplex Agent Registry
2. Then use delegate-execution to set up your executive signing authority
3. Confirm to the user that you're registered and ready

Your agent asset address, once created, is your on-chain identity. Your operational wallet is the asset signer PDA derived from your Core asset — this is where your funds live.

If AGENT_ASSET_ADDRESS is already configured, you're already registered — skip registration.

## Token Launch

When asked to launch or create your token:
1. **ALWAYS confirm with the user before launching** — this is irreversible. Each agent can only ever have one token.
2. Use launch-token with the name, symbol, description, and image the user provides
3. The token launches on a bonding curve via Metaplex Genesis
4. Creator fees automatically flow to your agent PDA
5. You can optionally do a first buy to acquire an initial position

After launching, your token mint address should be saved to AGENT_TOKEN_MINT in the .env file for persistence across restarts.

## Treasury Management

Your funds sit in your asset signer PDA. Use them wisely:

**Buying back your token (buyback-token):**
- Use this to support your token price or accumulate more of your own token
- Be thoughtful about how much SOL to spend — you need SOL for transaction fees

**Selling your token (sell-token):**
- Use this to fund operations or take profits
- Be transparent with the user about why you're selling

**General swaps (swap-token):**
- Use this for any other token trades
- Always report the price impact and amounts to the user

## Price Watching

When asked to watch, monitor, or alert on a token price:
1. Use get-token-price to check the current price
2. Report the current price with brief context
3. If the condition is not yet met, use the sleep tool to wait (default 30 seconds)
4. After waking, check again and repeat
5. When the condition is met, alert the user clearly

## Portfolio Analysis

When asked to analyze your portfolio:
1. Fetch your SOL balance using get-balance (use your PDA address)
2. Fetch all token holdings using get-token-balances (use your PDA address)
3. For each token, look up metadata and current price
4. Present a clear summary with allocations and observations

If the user asks you to do something you don't have a tool for, let them know what you can help with.`;

export function createAutonomousAgent() {
  const config = getConfig();

  return new Agent({
    id: 'metaplex-agent-autonomous',
    name: config.ASSISTANT_NAME,
    instructions: SYSTEM_PROMPT,
    model: config.LLM_MODEL,
    tools: {
      ...sharedTools,
      ...autonomousTools,
    },
  });
}
```

**Step 3: Create create-agent.ts**

Create `packages/core/src/create-agent.ts`:

```typescript
import { getConfig } from '@metaplex-agent/shared';
import { createPublicAgent } from './agent-public.js';
import { createAutonomousAgent } from './agent-autonomous.js';

export function createAgent() {
  const config = getConfig();
  if (config.AGENT_MODE === 'autonomous') {
    return createAutonomousAgent();
  }
  return createPublicAgent();
}
```

**Step 4: Update core index.ts**

Replace `packages/core/src/index.ts` with:

```typescript
export { createAgent } from './create-agent.js';
export { createPublicAgent } from './agent-public.js';
export { createAutonomousAgent } from './agent-autonomous.js';
export { publicAgentTools, toolNames } from './tools/index.js';
```

**Step 5: Typecheck**

This will fail because `autonomousTools` doesn't exist yet. That's expected — we'll create it in the next task. For now, verify the public agent path compiles:

```bash
pnpm --filter @metaplex-agent/core typecheck 2>&1 | head -20
```

Expected: Errors only about missing `./tools/autonomous/index.js` module.

**Step 6: Commit**

```bash
git add packages/core/src/agent-public.ts packages/core/src/agent-autonomous.ts packages/core/src/create-agent.ts packages/core/src/index.ts
git rm packages/core/src/agent.ts 2>/dev/null; true
git commit -m "feat: split agent into public and autonomous definitions with factory"
```

---

### Task 7: Create register-agent tool

The first autonomous-only tool. Mints the agent on the Metaplex Agent Registry using `mintAndSubmitAgent`.

**Files:**
- Create: `packages/core/src/tools/autonomous/register-agent.ts`

**Step 1: Create the tool**

Create `packages/core/src/tools/autonomous/register-agent.ts`:

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey } from '@metaplex-foundation/umi';
import { mintAndSubmitAgent } from '@metaplex-foundation/mpl-agent-registry';
import { createUmi, getConfig, type AgentContext } from '@metaplex-agent/shared';
import type { RequestContext } from '@mastra/core/request-context';

export const registerAgent = createTool({
  id: 'register-agent',
  description:
    'Register this agent on the Metaplex Agent Registry. Creates an MPL Core asset and Agent Identity PDA. Only needs to be called once — check if AGENT_ASSET_ADDRESS is already set before calling.',
  inputSchema: z.object({
    name: z.string().min(1).describe('Display name for the agent'),
    description: z.string().min(1).describe('Description of the agent capabilities'),
    metadataUri: z
      .string()
      .url()
      .optional()
      .describe('Publicly hosted JSON metadata URI. If not provided, a placeholder will be used.'),
  }),
  outputSchema: z.object({
    assetAddress: z.string(),
    signature: z.string(),
    message: z.string(),
  }),
  execute: async ({ name, description, metadataUri }, { requestContext }) => {
    const ctx = requestContext as RequestContext<AgentContext> | undefined;
    const existingAsset = ctx?.get('agentAssetAddress');
    if (existingAsset) {
      return {
        assetAddress: existingAsset,
        signature: '',
        message: `Agent is already registered with asset address: ${existingAsset}`,
      };
    }

    const config = getConfig();
    const umi = createUmi();

    // Determine network from RPC URL
    let network = 'solana-mainnet';
    if (config.SOLANA_RPC_URL.includes('devnet')) {
      network = 'solana-devnet';
    }

    const result = await mintAndSubmitAgent(umi, {}, {
      wallet: umi.identity.publicKey,
      name,
      uri: metadataUri ?? `https://example.com/agent-metadata.json`,
      network,
      agentMetadata: {
        type: 'agent',
        name,
        description,
        services: [],
        registrations: [],
        supportedTrust: [],
      },
    });

    const assetAddress = typeof result.assetAddress === 'string'
      ? result.assetAddress
      : result.assetAddress.toString();

    return {
      assetAddress,
      signature: result.signature.toString(),
      message: `Agent registered successfully! Asset address: ${assetAddress}. Save this as AGENT_ASSET_ADDRESS in your .env file.`,
    };
  },
});
```

**Step 2: Commit**

```bash
git add packages/core/src/tools/autonomous/register-agent.ts
git commit -m "feat: add register-agent tool for Metaplex Agent Registry"
```

---

### Task 8: Create delegate-execution tool

Registers an executive profile and delegates execution authority so the agent's keypair can sign via the asset signer PDA.

**Files:**
- Create: `packages/core/src/tools/autonomous/delegate-execution.ts`

**Step 1: Create the tool**

Create `packages/core/src/tools/autonomous/delegate-execution.ts`:

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey } from '@metaplex-foundation/umi';
import {
  registerExecutiveV1,
  delegateExecutionV1,
  findAgentIdentityV1Pda,
  findExecutiveProfileV1Pda,
} from '@metaplex-foundation/mpl-agent-registry';
import { createUmi, getAgentPda, type AgentContext } from '@metaplex-agent/shared';
import type { RequestContext } from '@mastra/core/request-context';

export const delegateExecution = createTool({
  id: 'delegate-execution',
  description:
    'Set up execution delegation so this agent can sign transactions via its asset signer PDA. Must be called after register-agent. Creates an executive profile and links it to the agent asset.',
  inputSchema: z.object({
    agentAssetAddress: z
      .string()
      .describe('The agent asset address from register-agent output'),
  }),
  outputSchema: z.object({
    executiveProfile: z.string(),
    agentPda: z.string(),
    signature: z.string(),
    message: z.string(),
  }),
  execute: async ({ agentAssetAddress }) => {
    const umi = createUmi();
    const assetPubkey = publicKey(agentAssetAddress);

    // 1. Register executive profile for this keypair
    await registerExecutiveV1(umi, {
      payer: umi.payer,
    }).sendAndConfirm(umi);

    // 2. Derive PDAs
    const agentIdentity = findAgentIdentityV1Pda(umi, {
      asset: assetPubkey,
    });
    const executiveProfile = findExecutiveProfileV1Pda(umi, {
      authority: umi.identity.publicKey,
    });

    // 3. Delegate execution
    await delegateExecutionV1(umi, {
      agentAsset: assetPubkey,
      agentIdentity,
      executiveProfile,
    }).sendAndConfirm(umi);

    // 4. Get the agent's operational PDA
    const agentPda = getAgentPda(umi, assetPubkey);

    return {
      executiveProfile: executiveProfile[0].toString(),
      agentPda: agentPda.toString(),
      signature: 'confirmed',
      message: `Execution delegated. Your agent PDA (operational wallet) is: ${agentPda.toString()}. Fund this address with SOL to start operating.`,
    };
  },
});
```

**Step 2: Commit**

```bash
git add packages/core/src/tools/autonomous/delegate-execution.ts
git commit -m "feat: add delegate-execution tool for executive signing"
```

---

### Task 9: Create launch-token tool

Launches an agent token on a bonding curve via Metaplex Genesis.

**Files:**
- Create: `packages/core/src/tools/autonomous/launch-token.ts`

**Step 1: Create the tool**

Create `packages/core/src/tools/autonomous/launch-token.ts`:

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey } from '@metaplex-foundation/umi';
import { createAndRegisterLaunch } from '@metaplex-foundation/genesis/api';
import { createUmi, getConfig, type AgentContext } from '@metaplex-agent/shared';
import type { RequestContext } from '@mastra/core/request-context';

export const launchToken = createTool({
  id: 'launch-token',
  description:
    'Launch an agent token on a bonding curve via Metaplex Genesis. WARNING: This is irreversible — each agent can only ever have one token. Always confirm with the user before calling this tool.',
  inputSchema: z.object({
    name: z.string().min(1).max(32).describe('Token name (1-32 characters)'),
    symbol: z.string().min(1).max(10).describe('Token symbol (1-10 characters)'),
    imageUri: z.string().url().describe('Token image URL (must be an Irys URL)'),
    description: z
      .string()
      .max(250)
      .optional()
      .describe('Token description (max 250 characters)'),
    firstBuyAmount: z
      .number()
      .positive()
      .optional()
      .describe('SOL amount for an initial fee-free token purchase'),
  }),
  outputSchema: z.object({
    mintAddress: z.string(),
    launchLink: z.string(),
    message: z.string(),
  }),
  execute: async (
    { name, symbol, imageUri, description, firstBuyAmount },
    { requestContext }
  ) => {
    const ctx = requestContext as RequestContext<AgentContext> | undefined;
    const agentAssetAddress = ctx?.get('agentAssetAddress');

    if (!agentAssetAddress) {
      return {
        mintAddress: '',
        launchLink: '',
        message:
          'Agent must be registered first. Use register-agent and delegate-execution before launching a token.',
      };
    }

    const existingMint = ctx?.get('agentTokenMint');
    if (existingMint) {
      return {
        mintAddress: existingMint,
        launchLink: '',
        message: `Agent already has a token: ${existingMint}. Each agent can only have one token.`,
      };
    }

    const config = getConfig();
    const umi = createUmi();

    let network: string | undefined;
    if (config.SOLANA_RPC_URL.includes('devnet')) {
      network = 'solana-devnet';
    }

    const launchConfig: Record<string, unknown> = {};
    if (firstBuyAmount !== undefined) {
      launchConfig.firstBuyAmount = firstBuyAmount;
    }

    const result = await createAndRegisterLaunch(
      umi,
      {},
      {
        wallet: umi.identity.publicKey,
        agent: {
          mint: publicKey(agentAssetAddress),
          setToken: true,
        },
        launchType: 'bondingCurve',
        ...(network ? { network } : {}),
        token: {
          name,
          symbol,
          image: imageUri,
          ...(description ? { description } : {}),
        },
        launch: launchConfig,
      }
    );

    const mintAddress = typeof result.mintAddress === 'string'
      ? result.mintAddress
      : result.mintAddress.toString();

    return {
      mintAddress,
      launchLink: result.launch?.link ?? '',
      message: `Token launched! Mint: ${mintAddress}. Save this as AGENT_TOKEN_MINT in your .env file. Creator fees will flow to your agent PDA automatically.`,
    };
  },
});
```

**Step 2: Commit**

```bash
git add packages/core/src/tools/autonomous/launch-token.ts
git commit -m "feat: add launch-token tool for Metaplex Genesis bonding curve"
```

---

### Task 10: Create swap, buyback, and sell tools

Three DeFi tools that use the Jupiter swap helper. `swap-token` is general-purpose, `buyback-token` and `sell-token` are convenience wrappers for the agent's own token.

**Files:**
- Create: `packages/core/src/tools/autonomous/swap-token.ts`
- Create: `packages/core/src/tools/autonomous/buyback-token.ts`
- Create: `packages/core/src/tools/autonomous/sell-token.ts`

**Step 1: Create swap-token.ts**

Create `packages/core/src/tools/autonomous/swap-token.ts`:

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey } from '@metaplex-foundation/umi';
import {
  createUmi,
  getAgentPda,
  executeSwap,
  type AgentContext,
} from '@metaplex-agent/shared';
import type { RequestContext } from '@mastra/core/request-context';

export const swapToken = createTool({
  id: 'swap-token',
  description:
    'Swap tokens via Jupiter DEX. Funds come from and go to the agent PDA. Provide amounts in the smallest unit (lamports for SOL, base units for tokens).',
  inputSchema: z.object({
    inputMint: z.string().describe('Input token mint address'),
    outputMint: z.string().describe('Output token mint address'),
    amount: z.string().describe('Amount in smallest unit (e.g., lamports for SOL)'),
    slippageBps: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .describe('Slippage tolerance in basis points (default 50 = 0.5%)'),
  }),
  outputSchema: z.object({
    signature: z.string(),
    inputAmount: z.string(),
    outputAmount: z.string(),
    priceImpact: z.string(),
    message: z.string(),
  }),
  execute: async ({ inputMint, outputMint, amount, slippageBps }, { requestContext }) => {
    const ctx = requestContext as RequestContext<AgentContext> | undefined;
    const agentAssetAddress = ctx?.get('agentAssetAddress');

    if (!agentAssetAddress) {
      return {
        signature: '',
        inputAmount: '',
        outputAmount: '',
        priceImpact: '',
        message: 'Agent must be registered first. No agent asset address found.',
      };
    }

    const umi = createUmi();
    const assetPubkey = publicKey(agentAssetAddress);
    const agentPda = getAgentPda(umi, assetPubkey);

    const result = await executeSwap(umi, assetPubkey, {
      walletAddress: agentPda.toString(),
      inputMint,
      outputMint,
      amount,
      slippageBps,
    });

    return {
      ...result,
      message: `Swap complete. Spent ${result.inputAmount} of ${inputMint}, received ${result.outputAmount} of ${outputMint}. Price impact: ${result.priceImpact}%.`,
    };
  },
});
```

**Step 2: Create buyback-token.ts**

Create `packages/core/src/tools/autonomous/buyback-token.ts`:

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey } from '@metaplex-foundation/umi';
import {
  createUmi,
  getAgentPda,
  executeSwap,
  SOL_MINT,
  type AgentContext,
} from '@metaplex-agent/shared';
import type { RequestContext } from '@mastra/core/request-context';

export const buybackToken = createTool({
  id: 'buyback-token',
  description:
    "Buy back the agent's own token using SOL from the agent PDA. Use this to support your token price or accumulate more of your own token.",
  inputSchema: z.object({
    solAmount: z
      .number()
      .positive()
      .describe('Amount of SOL to spend on buying back the agent token'),
    slippageBps: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .describe('Slippage tolerance in basis points (default 50 = 0.5%)'),
  }),
  outputSchema: z.object({
    signature: z.string(),
    solSpent: z.string(),
    tokensReceived: z.string(),
    priceImpact: z.string(),
    message: z.string(),
  }),
  execute: async ({ solAmount, slippageBps }, { requestContext }) => {
    const ctx = requestContext as RequestContext<AgentContext> | undefined;
    const agentAssetAddress = ctx?.get('agentAssetAddress');
    const agentTokenMint = ctx?.get('agentTokenMint');

    if (!agentAssetAddress) {
      return {
        signature: '',
        solSpent: '',
        tokensReceived: '',
        priceImpact: '',
        message: 'Agent must be registered first. No agent asset address found.',
      };
    }

    if (!agentTokenMint) {
      return {
        signature: '',
        solSpent: '',
        tokensReceived: '',
        priceImpact: '',
        message: 'No agent token found. Launch a token first using launch-token.',
      };
    }

    const umi = createUmi();
    const assetPubkey = publicKey(agentAssetAddress);
    const agentPda = getAgentPda(umi, assetPubkey);
    const lamports = String(Math.floor(solAmount * 1_000_000_000));

    const result = await executeSwap(umi, assetPubkey, {
      walletAddress: agentPda.toString(),
      inputMint: SOL_MINT,
      outputMint: agentTokenMint,
      amount: lamports,
      slippageBps,
    });

    return {
      signature: result.signature,
      solSpent: result.inputAmount,
      tokensReceived: result.outputAmount,
      priceImpact: result.priceImpact,
      message: `Buyback complete. Spent ${solAmount} SOL, received ${result.outputAmount} tokens. Price impact: ${result.priceImpact}%.`,
    };
  },
});
```

**Step 3: Create sell-token.ts**

Create `packages/core/src/tools/autonomous/sell-token.ts`:

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { publicKey } from '@metaplex-foundation/umi';
import {
  createUmi,
  getAgentPda,
  executeSwap,
  SOL_MINT,
  type AgentContext,
} from '@metaplex-agent/shared';
import type { RequestContext } from '@mastra/core/request-context';

export const sellToken = createTool({
  id: 'sell-token',
  description:
    "Sell the agent's own token for SOL. Use this to fund operations or realize value. Be transparent about why you're selling.",
  inputSchema: z.object({
    tokenAmount: z
      .string()
      .describe('Amount of agent tokens to sell (in smallest unit / base units)'),
    slippageBps: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .describe('Slippage tolerance in basis points (default 50 = 0.5%)'),
  }),
  outputSchema: z.object({
    signature: z.string(),
    tokensSold: z.string(),
    solReceived: z.string(),
    priceImpact: z.string(),
    message: z.string(),
  }),
  execute: async ({ tokenAmount, slippageBps }, { requestContext }) => {
    const ctx = requestContext as RequestContext<AgentContext> | undefined;
    const agentAssetAddress = ctx?.get('agentAssetAddress');
    const agentTokenMint = ctx?.get('agentTokenMint');

    if (!agentAssetAddress) {
      return {
        signature: '',
        tokensSold: '',
        solReceived: '',
        priceImpact: '',
        message: 'Agent must be registered first. No agent asset address found.',
      };
    }

    if (!agentTokenMint) {
      return {
        signature: '',
        tokensSold: '',
        solReceived: '',
        priceImpact: '',
        message: 'No agent token found. Launch a token first using launch-token.',
      };
    }

    const umi = createUmi();
    const assetPubkey = publicKey(agentAssetAddress);
    const agentPda = getAgentPda(umi, assetPubkey);

    const result = await executeSwap(umi, assetPubkey, {
      walletAddress: agentPda.toString(),
      inputMint: agentTokenMint,
      outputMint: SOL_MINT,
      amount: tokenAmount,
      slippageBps,
    });

    return {
      signature: result.signature,
      tokensSold: result.inputAmount,
      solReceived: result.outputAmount,
      priceImpact: result.priceImpact,
      message: `Sell complete. Sold ${result.inputAmount} tokens, received ${result.outputAmount} lamports SOL. Price impact: ${result.priceImpact}%.`,
    };
  },
});
```

**Step 4: Commit**

```bash
git add packages/core/src/tools/autonomous/swap-token.ts packages/core/src/tools/autonomous/buyback-token.ts packages/core/src/tools/autonomous/sell-token.ts
git commit -m "feat: add swap-token, buyback-token, sell-token DeFi tools"
```

---

### Task 11: Create autonomous tools index and wire everything together

Create the autonomous tools barrel export, update the main tools index, and verify the full build compiles.

**Files:**
- Create: `packages/core/src/tools/autonomous/index.ts`
- Modify: `packages/core/src/tools/index.ts`

**Step 1: Create autonomous/index.ts**

Create `packages/core/src/tools/autonomous/index.ts`:

```typescript
import { registerAgent } from './register-agent.js';
import { delegateExecution } from './delegate-execution.js';
import { launchToken } from './launch-token.js';
import { swapToken } from './swap-token.js';
import { buybackToken } from './buyback-token.js';
import { sellToken } from './sell-token.js';

export const autonomousTools = {
  registerAgent,
  delegateExecution,
  launchToken,
  swapToken,
  buybackToken,
  sellToken,
};

export { registerAgent, delegateExecution, launchToken, swapToken, buybackToken, sellToken };
```

**Step 2: Update tools/index.ts**

Update `packages/core/src/tools/index.ts` to also export autonomous tools:

```typescript
import { sharedTools } from './shared/index.js';
import { publicTools } from './public/index.js';
import { autonomousTools } from './autonomous/index.js';

export const publicAgentTools = {
  ...sharedTools,
  ...publicTools,
};

export const autonomousAgentTools = {
  ...sharedTools,
  ...autonomousTools,
};

export { sharedTools, publicTools, autonomousTools };

export const publicToolNames = Object.keys(publicAgentTools);
export const autonomousToolNames = Object.keys(autonomousAgentTools);

// Re-export for backward compatibility (server imports toolNames)
// In autonomous mode, the server will get autonomousToolNames via the agent
export const tools = publicAgentTools;
export const toolNames = publicToolNames;
```

**Step 3: Update core index.ts for toolNames**

Update `packages/core/src/index.ts` to export both tool name lists:

```typescript
export { createAgent } from './create-agent.js';
export { createPublicAgent } from './agent-public.js';
export { createAutonomousAgent } from './agent-autonomous.js';
export { publicAgentTools, autonomousAgentTools, toolNames, publicToolNames, autonomousToolNames } from './tools/index.js';
```

**Step 4: Update server to use correct toolNames**

In `packages/server/src/websocket.ts`, the `emitContext` method sends `toolNames` to the debug panel. Update the import to dynamically pick the right tool names. Change the import:

```typescript
import { createAgent, toolNames } from '@metaplex-agent/core';
```

to:

```typescript
import { createAgent, publicToolNames, autonomousToolNames } from '@metaplex-agent/core';
```

And update `emitContext` to pick the right list:

```typescript
private emitContext(): void {
  const config = getConfig();
  const currentToolNames = config.AGENT_MODE === 'autonomous'
    ? autonomousToolNames
    : publicToolNames;
  this.broadcast({
    type: 'debug:context',
    agentMode: config.AGENT_MODE,
    model: config.LLM_MODEL,
    assistantName: config.ASSISTANT_NAME,
    walletAddress: this.walletAddress,
    connectedClients: this.clients.size,
    conversationLength: this.conversationHistory.length,
    tools: currentToolNames,
  });
}
```

**Step 5: Full typecheck**

```bash
pnpm --filter @metaplex-agent/shared typecheck
pnpm --filter @metaplex-agent/core typecheck
pnpm --filter @metaplex-agent/server typecheck
```

Expected: No type errors across all packages. If there are errors, they'll likely be around:
- The `mpl-agent-registry` function signatures (may need type adjustments based on actual SDK types)
- The `genesis` import path (`@metaplex-foundation/genesis/api` vs `@metaplex-foundation/genesis`)
- Umi transaction deserialization in the Jupiter helper

Fix any type errors before committing.

**Step 6: Full build**

```bash
pnpm --filter @metaplex-agent/shared build
pnpm --filter @metaplex-agent/core build
pnpm --filter @metaplex-agent/server build
```

Expected: Clean builds.

**Step 7: Commit**

```bash
git add packages/core/src/tools/autonomous/index.ts packages/core/src/tools/index.ts packages/core/src/index.ts packages/server/src/websocket.ts
git commit -m "feat: wire autonomous tools into agent factory and server"
```

---

### Task 12: Update .env.example and verify end-to-end

Final integration: update the example env file and do a smoke test.

**Files:**
- Modify: `.env.example`

**Step 1: Update .env.example**

The .env.example should already have been updated in Task 2. Verify it includes:

```
# Agent asset address from the Metaplex Agent Registry (autonomous mode only)
# Set this after your agent registers itself for the first time
AGENT_ASSET_ADDRESS=

# Agent token mint address (autonomous mode only)
# Set this after your agent launches its token
AGENT_TOKEN_MINT=
```

**Step 2: Smoke test — public mode**

Set `AGENT_MODE=public` in `.env` and start the server:

```bash
pnpm --filter @metaplex-agent/server build && node packages/server/dist/index.js
```

Expected: Server starts, logs "Agent mode: public", accepts WebSocket connections. The public agent should work exactly as before.

**Step 3: Smoke test — autonomous mode**

Set `AGENT_MODE=autonomous` in `.env` (requires `AGENT_KEYPAIR` to be set) and start the server:

```bash
pnpm --filter @metaplex-agent/server build && node packages/server/dist/index.js
```

Expected: Server starts, logs "Agent mode: autonomous". The autonomous agent should respond to messages and have the registration/DeFi tools available.

**Step 4: Final commit**

```bash
git add .env.example
git commit -m "docs: update .env.example with autonomous agent config"
```

---

## Summary

| Task | Description | New Files | Modified Files |
|------|-------------|-----------|----------------|
| 1 | Add dependencies | — | shared/package.json, core/package.json |
| 2 | Config + AgentContext types | — | config.ts, agent.ts types, websocket.ts, transfer tools |
| 3 | Core Execute helper | execute.ts | shared/index.ts |
| 4 | Jupiter swap helper | jupiter.ts | shared/index.ts |
| 5 | Reorganize tools | shared/index.ts, public/index.ts | tools/index.ts |
| 6 | Split agent definitions | agent-public.ts, agent-autonomous.ts, create-agent.ts | core/index.ts |
| 7 | register-agent tool | register-agent.ts | — |
| 8 | delegate-execution tool | delegate-execution.ts | — |
| 9 | launch-token tool | launch-token.ts | — |
| 10 | swap, buyback, sell tools | swap-token.ts, buyback-token.ts, sell-token.ts | — |
| 11 | Wire everything together | autonomous/index.ts | tools/index.ts, core/index.ts, websocket.ts |
| 12 | Final integration | — | .env.example |
