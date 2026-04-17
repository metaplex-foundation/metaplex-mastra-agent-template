# Unified Agent Identity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Collapse the identity distinction between public and autonomous agents so all agents register on-chain, have a wallet (PDA), and optionally a token — with the only difference being transaction routing (user signs vs agent signs).

**Architecture:** Both agent modes share a keypair, registration, PDA wallet, and treasury tools. Public mode prepends a SOL fee to every user-facing transaction. A persistent `agent-state.json` file saves agent identity across restarts. The `autonomous/` tool directory is eliminated — its tools move to `shared/`.

**Tech Stack:** TypeScript, Mastra, Umi, Zod, pnpm monorepo

**Design doc:** `docs/plans/2026-04-15-unified-agent-identity-design.md`

---

### Task 1: Add persistent state file

**Files:**
- Create: `packages/shared/src/state.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `.gitignore`

**Step 1: Create `packages/shared/src/state.ts`**

```typescript
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';

const STATE_FILENAME = 'agent-state.json';

export interface AgentState {
  agentAssetAddress?: string;
  agentTokenMint?: string;
}

/**
 * Find the state file by walking up from cwd (same logic as .env resolution).
 */
function findStateFile(from: string): string {
  let dir = from;
  while (true) {
    const candidate = resolve(dir, STATE_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Default: put it next to where .env would be (workspace root)
  // Walk up again looking for package.json with workspaces or .env
  dir = from;
  while (true) {
    if (existsSync(resolve(dir, '.env')) || existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      return resolve(dir, STATE_FILENAME);
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(from, STATE_FILENAME);
    dir = parent;
  }
}

let _statePath: string | null = null;

function getStatePath(): string {
  if (!_statePath) {
    _statePath = findStateFile(process.cwd());
  }
  return _statePath;
}

export function getState(): AgentState {
  const path = getStatePath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as AgentState;
  } catch {
    return {};
  }
}

export function setState(updates: Partial<AgentState>): void {
  const current = getState();
  const merged = { ...current, ...updates };
  writeFileSync(getStatePath(), JSON.stringify(merged, null, 2) + '\n');
}
```

**Step 2: Export from `packages/shared/src/index.ts`**

Add this line:

```typescript
export * from './state.js';
```

**Step 3: Add `agent-state.json` to `.gitignore`**

Append:

```
agent-state.json
```

**Step 4: Commit**

```bash
git add packages/shared/src/state.ts packages/shared/src/index.ts .gitignore
git commit -m "feat: add persistent agent-state.json for identity persistence"
```

---

### Task 2: Update config — new env vars and state file fallback

**Files:**
- Modify: `packages/shared/src/config.ts`

**Step 1: Update the env schema and `getConfig()`**

Changes to `config.ts`:

1. Add `AGENT_FEE_SOL` with default `0.001`
2. Add `TOKEN_OVERRIDE` as optional string
3. Make `AGENT_KEYPAIR` required (remove `.optional()`, add `.min(1)`)
4. After parsing env, merge state file values for `AGENT_ASSET_ADDRESS` and `AGENT_TOKEN_MINT` when not set in `.env`

```typescript
// In the envSchema, change:
AGENT_KEYPAIR: z.string().min(1, 'AGENT_KEYPAIR is required'),

// Add new fields:
AGENT_FEE_SOL: z.coerce.number().default(0.001),
TOKEN_OVERRIDE: z.string().optional(),
```

In `getConfig()`, after `safeParse`, merge state file values:

```typescript
import { getState } from './state.js';

// After _config = result.data:
const state = getState();
if (!_config.AGENT_ASSET_ADDRESS && state.agentAssetAddress) {
  _config.AGENT_ASSET_ADDRESS = state.agentAssetAddress;
}
if (!_config.AGENT_TOKEN_MINT && state.agentTokenMint) {
  _config.AGENT_TOKEN_MINT = state.agentTokenMint;
}
```

**Step 2: Build and verify**

Run: `pnpm --filter @metaplex-agent/shared typecheck`
Expected: PASS (no type errors)

**Step 3: Commit**

```bash
git add packages/shared/src/config.ts
git commit -m "feat: add AGENT_FEE_SOL, TOKEN_OVERRIDE config; require AGENT_KEYPAIR; merge state file"
```

---

### Task 3: Update AgentContext type

**Files:**
- Modify: `packages/shared/src/types/agent.ts`

**Step 1: Add new fields to AgentContext**

```typescript
export interface AgentContext {
  walletAddress: string | null;
  transactionSender: TransactionSender | null;
  agentMode: 'public' | 'autonomous';
  agentAssetAddress: string | null;
  agentTokenMint: string | null;
  agentFeeSol: number;
  tokenOverride: string | null;
}
```

**Step 2: Commit**

```bash
git add packages/shared/src/types/agent.ts
git commit -m "feat: add agentFeeSol and tokenOverride to AgentContext"
```

---

### Task 4: Update Umi to always load keypair

**Files:**
- Modify: `packages/shared/src/umi.ts`

**Step 1: Remove the mode check — always load keypair**

The current `createUmi()` only loads the keypair in autonomous mode. Change it to always load the keypair since both modes now require it.

```typescript
export function createUmi(): Umi {
  const config = getConfig();
  const umi = createUmiBase(config.SOLANA_RPC_URL).use(mplToolbox());

  const secretKey = bs58.decode(config.AGENT_KEYPAIR);
  const keypair = umi.eddsa.createKeypairFromSecretKey(secretKey);
  const signer = createSignerFromKeypair(umi, keypair);
  umi.use(signerIdentity(signer));

  return umi;
}
```

Remove the `if (config.AGENT_MODE === 'autonomous')` block and the `if (!config.AGENT_KEYPAIR)` error check (Zod now validates AGENT_KEYPAIR is required and non-empty).

**Step 2: Build and verify**

Run: `pnpm --filter @metaplex-agent/shared typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/shared/src/umi.ts
git commit -m "feat: always load agent keypair in Umi (both modes need identity)"
```

---

### Task 5: Add fee prepend to `submitOrSend`

**Files:**
- Modify: `packages/shared/src/transaction.ts`

**Step 1: Add fee prepend logic in public mode**

In the public mode branch, before building the transaction, prepend a `transferSol` instruction from the user's wallet to the agent's asset signer PDA.

Import `findAssetSignerPda` from `@metaplex-foundation/mpl-core` and `publicKey` from `@metaplex-foundation/umi`.

```typescript
import { findAssetSignerPda } from '@metaplex-foundation/mpl-core';
import {
  publicKey,
  // ... existing imports
} from '@metaplex-foundation/umi';
import { transferSol } from '@metaplex-foundation/mpl-toolbox';
```

In the public mode block, after validating wallet is connected, before building the transaction:

```typescript
// Prepend fee if agent is registered
if (context.agentAssetAddress && context.agentFeeSol > 0) {
  const agentPda = findAssetSignerPda(umi, {
    asset: publicKey(context.agentAssetAddress),
  })[0];
  builder = transferSol(umi, {
    source: walletSigner,
    destination: agentPda,
    amount: sol(context.agentFeeSol),
  }).add(builder);
}
```

Note: `transferSol` is imported from `@metaplex-foundation/mpl-toolbox` (already a dependency). We also need `sol` from `@metaplex-foundation/umi`.

The full `AgentContext` type now requires `agentFeeSol` and `tokenOverride`, so update the function signature to use the new type. The existing callers in `transfer-sol.ts` and `transfer-token.ts` will need updating in Task 8.

**Step 2: Build and verify**

Run: `pnpm --filter @metaplex-agent/shared typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/shared/src/transaction.ts
git commit -m "feat: prepend SOL fee to user transactions in public mode"
```

---

### Task 6: Move autonomous tools to shared

**Files:**
- Move: `packages/core/src/tools/autonomous/register-agent.ts` → `packages/core/src/tools/shared/register-agent.ts`
- Move: `packages/core/src/tools/autonomous/delegate-execution.ts` → `packages/core/src/tools/shared/delegate-execution.ts`
- Move: `packages/core/src/tools/autonomous/launch-token.ts` → `packages/core/src/tools/shared/launch-token.ts`
- Move: `packages/core/src/tools/autonomous/swap-token.ts` → `packages/core/src/tools/shared/swap-token.ts`
- Move: `packages/core/src/tools/autonomous/buyback-token.ts` → `packages/core/src/tools/shared/buyback-token.ts`
- Move: `packages/core/src/tools/autonomous/sell-token.ts` → `packages/core/src/tools/shared/sell-token.ts`
- Delete: `packages/core/src/tools/autonomous/index.ts`
- Delete: `packages/core/src/tools/autonomous/` (directory)

**Step 1: Move files**

```bash
mv packages/core/src/tools/autonomous/register-agent.ts packages/core/src/tools/shared/
mv packages/core/src/tools/autonomous/delegate-execution.ts packages/core/src/tools/shared/
mv packages/core/src/tools/autonomous/launch-token.ts packages/core/src/tools/shared/
mv packages/core/src/tools/autonomous/swap-token.ts packages/core/src/tools/shared/
mv packages/core/src/tools/autonomous/buyback-token.ts packages/core/src/tools/shared/
mv packages/core/src/tools/autonomous/sell-token.ts packages/core/src/tools/shared/
rm -rf packages/core/src/tools/autonomous/
```

**Step 2: Update `packages/core/src/tools/shared/index.ts`**

Add the moved tools to the shared tools export:

```typescript
import { getBalance } from './get-balance.js';
import { getTokenBalances } from './get-token-balances.js';
import { getTransaction } from './get-transaction.js';
import { getTokenPrice } from './get-token-price.js';
import { getTokenMetadata } from './get-token-metadata.js';
import { sleep } from './sleep.js';
import { registerAgent } from './register-agent.js';
import { delegateExecution } from './delegate-execution.js';
import { launchToken } from './launch-token.js';
import { swapToken } from './swap-token.js';
import { buybackToken } from './buyback-token.js';
import { sellToken } from './sell-token.js';

export const sharedTools = {
  getBalance,
  getTokenBalances,
  getTransaction,
  getTokenPrice,
  getTokenMetadata,
  sleep,
  registerAgent,
  delegateExecution,
  launchToken,
  swapToken,
  buybackToken,
  sellToken,
};

export {
  getBalance, getTokenBalances, getTransaction, getTokenPrice, getTokenMetadata, sleep,
  registerAgent, delegateExecution, launchToken, swapToken, buybackToken, sellToken,
};
```

**Step 3: Commit**

```bash
git add packages/core/src/tools/shared/ packages/core/src/tools/autonomous/
git commit -m "refactor: move autonomous tools to shared (all agents need identity+treasury)"
```

---

### Task 7: Update tool index and core exports

**Files:**
- Modify: `packages/core/src/tools/index.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Simplify `packages/core/src/tools/index.ts`**

Remove the `autonomous/` import entirely. Both agent types use shared tools; public also gets public tools.

```typescript
import { sharedTools } from './shared/index.js';
import { publicTools } from './public/index.js';

export const publicAgentTools = {
  ...sharedTools,
  ...publicTools,
};

// Autonomous agents only get shared tools (no user-facing transfer tools)
export const autonomousAgentTools = {
  ...sharedTools,
};

export { sharedTools, publicTools };

export const publicToolNames = Object.keys(publicAgentTools);
export const autonomousToolNames = Object.keys(autonomousAgentTools);
```

**Step 2: Update `packages/core/src/index.ts`**

Remove the `autonomousTools` named export since it no longer exists as a separate concept:

```typescript
export { createAgent } from './create-agent.js';
export { createPublicAgent } from './agent-public.js';
export { createAutonomousAgent } from './agent-autonomous.js';
export {
  publicAgentTools,
  autonomousAgentTools,
  publicToolNames,
  autonomousToolNames,
} from './tools/index.js';
```

(Remove `toolNames` backward-compat export if present — no more `autonomousTools` named export.)

**Step 3: Build and verify**

Run: `pnpm --filter @metaplex-agent/core typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/core/src/tools/index.ts packages/core/src/index.ts
git commit -m "refactor: collapse tool exports — autonomous dir removed, shared expanded"
```

---

### Task 8: Update tools to use new AgentContext shape

**Files:**
- Modify: `packages/core/src/tools/public/transfer-sol.ts`
- Modify: `packages/core/src/tools/public/transfer-token.ts`
- Modify: `packages/core/src/tools/shared/register-agent.ts`
- Modify: `packages/core/src/tools/shared/launch-token.ts`
- Modify: `packages/core/src/tools/shared/buyback-token.ts`
- Modify: `packages/core/src/tools/shared/sell-token.ts`

**Step 1: Update `transfer-sol.ts` and `transfer-token.ts`**

Both files extract `AgentContext` from requestContext. They need to include the two new fields. In the context extraction block, add:

```typescript
const context: AgentContext = {
  walletAddress: ctx?.get('walletAddress') ?? null,
  transactionSender: ctx?.get('transactionSender') ?? null,
  agentMode: ctx?.get('agentMode') ?? 'public',
  agentAssetAddress: ctx?.get('agentAssetAddress') ?? null,
  agentTokenMint: ctx?.get('agentTokenMint') ?? null,
  agentFeeSol: ctx?.get('agentFeeSol') ?? 0.001,
  tokenOverride: ctx?.get('tokenOverride') ?? null,
};
```

**Step 2: Update `register-agent.ts` — persist to state file**

Add import: `import { setState } from '@metaplex-agent/shared';`

After successful registration (after getting `result.assetAddress`), add:

```typescript
setState({ agentAssetAddress: result.assetAddress });
```

Update the success message to remove the "Save this as AGENT_ASSET_ADDRESS" instruction since it's now auto-persisted:

```typescript
message: `Agent registered successfully! Asset address: ${result.assetAddress}. This has been saved automatically.`,
```

**Step 3: Update `launch-token.ts` — persist to state file + TOKEN_OVERRIDE check**

Add import: `import { setState } from '@metaplex-agent/shared';`

At the top of `execute`, check for TOKEN_OVERRIDE:

```typescript
const tokenOverride = ctx?.get('tokenOverride');
if (tokenOverride) {
  return {
    mintAddress: '',
    launchLink: '',
    message: `TOKEN_OVERRIDE is set to ${tokenOverride}. This agent is configured to buy back an existing token instead of launching its own.`,
  };
}
```

After successful launch, persist:

```typescript
setState({ agentTokenMint: result.mintAddress });
```

Update success message to remove "Save this as AGENT_TOKEN_MINT" instruction.

**Step 4: Update `buyback-token.ts` — TOKEN_OVERRIDE support**

Change how `agentTokenMint` is resolved. Instead of just reading from context, check TOKEN_OVERRIDE first:

```typescript
const tokenOverride = ctx?.get('tokenOverride');
const agentTokenMint = tokenOverride ?? ctx?.get('agentTokenMint');
```

Update the "no token" error message:

```typescript
if (!agentTokenMint) {
  return {
    // ...
    message: 'No token configured. Launch a token with launch-token, or set TOKEN_OVERRIDE in .env.',
  };
}
```

**Step 5: Update `sell-token.ts` — TOKEN_OVERRIDE support**

Same pattern as buyback:

```typescript
const tokenOverride = ctx?.get('tokenOverride');
const agentTokenMint = tokenOverride ?? ctx?.get('agentTokenMint');
```

Update the "no token" error message similarly.

**Step 6: Build and verify**

Run: `pnpm --filter @metaplex-agent/core typecheck`
Expected: PASS

**Step 7: Commit**

```bash
git add packages/core/src/tools/
git commit -m "feat: update tools for new AgentContext, state persistence, TOKEN_OVERRIDE"
```

---

### Task 9: Create shared system prompt with mode addendums

**Files:**
- Create: `packages/core/src/prompts.ts`

**Step 1: Create `packages/core/src/prompts.ts`**

```typescript
import type { AgentMode } from '@metaplex-agent/shared';

const BASE_PROMPT = `You are a Solana blockchain agent with your own on-chain identity and wallet.

## Bootstrap (CRITICAL — Do This First)

On your VERY FIRST interaction, before doing anything else:
1. Check if you're already registered (AGENT_ASSET_ADDRESS will be set if so)
2. If NOT registered, use register-agent to mint yourself on the Metaplex Agent Registry
3. Then use delegate-execution to set up your executive signing authority
4. Confirm to the user that you're registered and ready

You MUST complete registration before performing any other actions. If the user asks you to do something and you're not registered yet, register first, then do what they asked.

## Your Identity

- Your keypair is your executive authority — it authorizes operations on your behalf
- Your asset signer PDA is your real wallet — it holds your funds and receives fees
- Your agent asset address is your on-chain identity on the Metaplex Agent Registry

## Tools Available

You can:
- Check SOL balances for any wallet address
- View token holdings for any wallet
- Look up transaction details
- Get current USD prices for any Solana token
- Get token metadata (name, symbol, image)
- Register yourself on the Metaplex Agent Registry
- Delegate execution authority to your keypair
- Launch your own agent token (irreversible — confirm with user first)
- Swap tokens via Jupiter DEX
- Buy back your own token (SOL → your token)
- Sell your own token allocation (your token → SOL)
- Sleep/pause for a specified duration (for monitoring loops)

## Token Launch

When asked to launch or create your token:
1. **If TOKEN_OVERRIDE is configured, do NOT launch.** Your buyback target is already set. Tell the user.
2. **ALWAYS confirm with the user before launching** — this is irreversible. Each agent can only ever have one token.
3. Use launch-token with the name, symbol, description, and image the user provides
4. The token launches on a bonding curve via Metaplex Genesis
5. Creator fees automatically flow to your agent PDA

## Treasury Management

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
3. If the condition is not yet met, use the sleep tool to wait (default 30 seconds unless the user specifies an interval)
4. After waking, check the price again and repeat
5. When the condition is met, alert the user clearly
6. Ask if they want to continue watching or stop

Always tell the user what you're doing: "SOL is at $195.40, still below your $200 target. Checking again in 30 seconds..."

## Portfolio Analysis

When asked to analyze a portfolio:
1. Fetch the SOL balance using get-balance
2. Fetch all token holdings using get-token-balances
3. For each token found, look up its metadata and current price
4. Calculate the total portfolio value in USD and percentage allocation for each holding
5. Present a clear summary with each holding, total value, and observations

Narrate your progress as you work through each step so the user can follow along.

If the user asks you to do something you don't have a tool for, let them know what you can help with.`;

const PUBLIC_ADDENDUM = `

## Transaction Mode: Public

You operate in public mode. When users request operations (transfers, swaps):
- Build the transaction and send it to their wallet for approval — they sign it in the UI
- A small SOL fee is automatically included in each transaction to fund your operations
- You also have transfer-sol and transfer-token tools for sending funds from the user's wallet

When the user has connected their wallet, use that address as the default for operations unless they specify a different address.

When the user requests a transfer, execute it immediately — the UI and wallet will prompt for approval before signing.`;

const AUTONOMOUS_ADDENDUM = `

## Transaction Mode: Autonomous

You operate in autonomous mode. You sign and submit all transactions yourself from your operational wallet.
- Your trading funds sit in your agent keypair wallet (umi.identity)
- Jupiter swaps use this wallet directly
- Registration and delegation operations use the asset signer PDA
- You need SOL in your keypair wallet to pay transaction fees`;

export function buildSystemPrompt(mode: AgentMode): string {
  return BASE_PROMPT + (mode === 'public' ? PUBLIC_ADDENDUM : AUTONOMOUS_ADDENDUM);
}
```

**Step 2: Commit**

```bash
git add packages/core/src/prompts.ts
git commit -m "feat: unified system prompt with mode-specific addendums"
```

---

### Task 10: Update agent definitions to use shared prompt

**Files:**
- Modify: `packages/core/src/agent-public.ts`
- Modify: `packages/core/src/agent-autonomous.ts`

**Step 1: Update `agent-public.ts`**

Replace the inline SYSTEM_PROMPT with the shared builder:

```typescript
import { Agent } from '@mastra/core/agent';
import { getConfig } from '@metaplex-agent/shared';
import { publicAgentTools } from './tools/index.js';
import { buildSystemPrompt } from './prompts.js';

export function createPublicAgent() {
  const config = getConfig();

  return new Agent({
    id: 'metaplex-agent-public',
    name: config.ASSISTANT_NAME,
    instructions: buildSystemPrompt('public'),
    model: config.LLM_MODEL,
    tools: publicAgentTools,
  });
}
```

**Step 2: Update `agent-autonomous.ts`**

```typescript
import { Agent } from '@mastra/core/agent';
import { getConfig } from '@metaplex-agent/shared';
import { autonomousAgentTools } from './tools/index.js';
import { buildSystemPrompt } from './prompts.js';

export function createAutonomousAgent() {
  const config = getConfig();

  return new Agent({
    id: 'metaplex-agent-autonomous',
    name: config.ASSISTANT_NAME,
    instructions: buildSystemPrompt('autonomous'),
    model: config.LLM_MODEL,
    tools: autonomousAgentTools,
  });
}
```

**Step 3: Build and verify**

Run: `pnpm --filter @metaplex-agent/core typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/core/src/agent-public.ts packages/core/src/agent-autonomous.ts
git commit -m "refactor: use shared system prompt builder in both agent definitions"
```

---

### Task 11: Update WebSocket server to pass new context fields

**Files:**
- Modify: `packages/server/src/websocket.ts`

**Step 1: Add new fields to RequestContext**

In `handleChatMessage`, update the `RequestContext` construction to include the new fields:

```typescript
const requestContext = new RequestContext<AgentContext>([
  ['walletAddress', this.walletAddress],
  ['transactionSender', transactionSender],
  ['agentMode', config.AGENT_MODE],
  ['agentAssetAddress', config.AGENT_ASSET_ADDRESS ?? null],
  ['agentTokenMint', config.AGENT_TOKEN_MINT ?? null],
  ['agentFeeSol', config.AGENT_FEE_SOL],
  ['tokenOverride', config.TOKEN_OVERRIDE ?? null],
]);
```

**Step 2: Build and verify**

Run: `pnpm --filter @metaplex-agent/server typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/server/src/websocket.ts
git commit -m "feat: pass agentFeeSol and tokenOverride in WebSocket request context"
```

---

### Task 12: Update .env.example

**Files:**
- Modify: `.env.example`

**Step 1: Update `.env.example`**

Full replacement:

```
# =============================================================================
# Agent Configuration
# =============================================================================

# Agent mode: "public" (builds transactions for user wallet, with fee)
#             "autonomous" (agent signs & submits all transactions itself)
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

# Agent keypair as base58-encoded secret key (required for both modes)
# Generate one with: solana-keygen new --no-bip39-passphrase --outfile /dev/stdout
AGENT_KEYPAIR=

# =============================================================================
# Agent Identity (auto-persisted to agent-state.json after first run)
# =============================================================================

# Agent asset address from the Metaplex Agent Registry
# Set this to skip re-registration, or let the agent register itself on first run
AGENT_ASSET_ADDRESS=

# Agent token mint address
# Set this after your agent launches its token, or let it auto-persist
AGENT_TOKEN_MINT=

# Override the buyback target token (e.g., MPLX mint address)
# When set, the agent skips launch-token and buys back this token instead
TOKEN_OVERRIDE=

# =============================================================================
# Fee Configuration (Public Mode)
# =============================================================================

# SOL fee prepended to every user transaction to fund agent operations
AGENT_FEE_SOL=0.001

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

# =============================================================================
# External APIs (Optional)
# =============================================================================

# Jupiter Price API key (optional — needed for price watching and portfolio analysis)
# Get one at: https://developers.jup.ag
JUPITER_API_KEY=
```

**Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: update .env.example with unified identity model"
```

---

### Task 13: Full build and smoke test

**Step 1: Clean and rebuild all packages**

```bash
pnpm run clean --recursive && pnpm run build --recursive
```

Expected: All packages build successfully with no errors.

**Step 2: Verify TypeScript compiles**

```bash
pnpm --filter @metaplex-agent/shared typecheck
pnpm --filter @metaplex-agent/core typecheck
pnpm --filter @metaplex-agent/server typecheck
```

Expected: All pass.

**Step 3: Commit any fixups, then tag**

```bash
git commit -m "chore: build verification for unified agent identity"
```
