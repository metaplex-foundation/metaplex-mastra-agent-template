# Autonomous Agent Design: Registration, Token Launch & Treasury Management

## Goal

Add a 1-to-1 autonomous agent alongside the existing 1-to-many public agent in the same repo. The autonomous agent registers itself on the Metaplex Agent Registry, delegates its keypair for execution, launches an agent token, and manages its treasury through DeFi operations.

## Architecture: Two Agent Definitions

Split the current single `agent.ts` into two files with distinct tool sets and system prompts. The server picks which agent to instantiate based on `AGENT_MODE`.

```
packages/core/src/
├── agent-public.ts          # Current agent, renamed
├── agent-autonomous.ts      # New autonomous agent
├── create-agent.ts          # Factory: picks agent based on AGENT_MODE
└── tools/
    ├── shared/              # Tools used by both agents
    │   ├── get-balance.ts
    │   ├── get-token-balances.ts
    │   ├── get-transaction.ts
    │   ├── get-token-price.ts
    │   ├── get-token-metadata.ts
    │   └── sleep.ts
    ├── public/              # Tools only for the public agent
    │   ├── transfer-sol.ts
    │   └── transfer-token.ts
    └── autonomous/          # Tools only for the autonomous agent
        ├── register-agent.ts
        ├── delegate-execution.ts
        ├── launch-token.ts
        ├── swap-token.ts
        ├── buyback-token.ts
        ├── sell-token.ts
        └── index.ts
```

### Factory Pattern

`create-agent.ts` replaces the current `agent.ts` export:

```typescript
export function createAgent() {
  const config = getConfig();
  if (config.AGENT_MODE === 'autonomous') {
    return createAutonomousAgent();
  }
  return createPublicAgent();
}
```

The server code (`websocket.ts`) doesn't change — it already calls `createAgent()`.

## Bootstrap Sequence (Agent-Driven)

The autonomous agent handles its own registration conversationally. On first interaction, the agent checks whether it's already registered and walks through setup if not.

### Tools

#### `register-agent` — Mint Agent on Registry

- **SDK**: `@metaplex-foundation/mpl-agent-registry`
- **Function**: `mintAndSubmitAgent(umi, {}, { wallet, name, uri, network, agentMetadata })`
- **Input**: `name` (string), `description` (string), `imageUri` (string, optional)
- **Output**: `{ assetAddress: string, signature: string }`
- **Behavior**:
  1. Uploads metadata JSON to a publicly accessible URI (or uses a provided URI)
  2. Calls `mintAndSubmitAgent` with agent's keypair as wallet
  3. Stores `assetAddress` in RequestContext for subsequent tools
  4. Returns the asset address and confirmation signature
- **Notes**:
  - The `agentMetadata` object includes `type: 'agent'`, name, description
  - Creates an MPL Core asset + Agent Identity PDA in one transaction
  - Network comes from config (maps RPC URL to network name)

#### `delegate-execution` — Register Executive & Delegate

- **SDK**: `@metaplex-foundation/mpl-agent-registry`
- **Functions**: `registerExecutiveV1(umi, { payer })` then `delegateExecutionV1(umi, { agentAsset, agentIdentity, executiveProfile })`
- **Input**: `agentAssetAddress` (string, from register-agent output)
- **Output**: `{ executiveProfile: string, signature: string }`
- **Behavior**:
  1. Calls `registerExecutiveV1` to create an executive profile for the agent's keypair
  2. Calls `delegateExecutionV1` to link the agent asset to the executive profile
  3. Returns the executive profile PDA and confirmation
- **Notes**:
  - After delegation, the agent's keypair can sign on behalf of the agent's execute PDA
  - The execute PDA (derived from `['mpl-core-execute', <agent_mint>]`) becomes the agent's operational wallet

### System Prompt Guidance

The autonomous agent's system prompt includes:

```
## Self-Registration

When you first start or when asked to set up:
1. Check if you're already registered (try looking up your own asset)
2. If not registered, use register-agent to mint yourself on the Agent Registry
3. Then use delegate-execution to set up your executive signing authority
4. Confirm to the user that you're registered and ready

Your agent asset address, once created, is your on-chain identity.
```

## Token Launch

#### `launch-token` — Create Agent Token

- **SDK**: `@metaplex-foundation/genesis`
- **Function**: `createAndRegisterLaunch(umi, {}, { wallet, agent, launchType, token, launch })`
- **Input**:
  - `name` (string, 1-32 chars)
  - `symbol` (string, 1-10 chars)
  - `description` (string, optional, max 250 chars)
  - `imageUri` (string, must be Irys URL)
  - `firstBuyAmount` (number, optional, SOL amount for initial fee-free swap)
- **Output**: `{ mintAddress: string, launchLink: string, signature: string }`
- **Behavior**:
  1. Requires agent to be registered first (needs `agentAssetAddress`)
  2. Calls `createAndRegisterLaunch` with `launchType: 'bondingCurve'`
  3. Sets `agent.setToken: true` (irreversible — one token per agent ever)
  4. Creator fees route to the agent's Core asset signer PDA automatically
  5. Returns the token mint address and a link to view on Metaplex
- **Critical**: The `setToken: true` flag is permanent. The system prompt must warn the agent to confirm with the user before launching.
- **Notes**:
  - Token supply, virtual reserves, and lock schedules use protocol defaults
  - `firstBuyAmount` allows the agent to acquire an initial token position

## Core Execute: The Agent's Operational Wallet

After registration, the agent's funds and operations flow through its **asset signer PDA**, not the raw keypair. The keypair is only used to authorize `execute()` calls — the PDA is the actual wallet.

### PDA Derivation

```typescript
import { findAssetSignerPda } from '@metaplex-foundation/mpl-core';

const agentPda = findAssetSignerPda(umi, { asset: agentAssetAddress });
```

This PDA can hold SOL, SPL tokens, and sign any instruction via CPI.

### Transaction Flow for All Autonomous Operations

Every autonomous tool that moves funds follows this pattern:

1. Build the inner instruction(s) using the **asset signer PDA** as payer/authority (via `createNoopSigner(agentPda)`)
2. Wrap in `execute(umi, { asset, instructions, ... })`
3. The keypair signs the outer transaction (as asset owner)
4. On-chain, the execute instruction validates owner signature, then the PDA signs the inner instructions via CPI

```typescript
import { execute } from '@metaplex-foundation/mpl-core';
import { fetchAsset } from '@metaplex-foundation/mpl-core';

const asset = await fetchAsset(umi, agentAssetAddress);
const innerIx = buildSwapInstruction(agentPda, ...); // PDA is the signer

const tx = await execute(umi, {
  asset,
  instructions: innerIx,
});
await tx.sendAndConfirm(umi);
```

### Implications

- **Balance checks**: `get-balance` and `get-token-balances` should check the PDA's balances, not the keypair's
- **Jupiter swaps**: The swap helper builds instructions with the PDA as wallet, then wraps in `execute()`
- **Token launch**: Creator fees automatically route to the PDA (derived from `['mpl-core-execute', <agent_mint>]`)
- **Keypair SOL**: The keypair only needs enough SOL to pay transaction fees for the `execute()` wrapper. All real funds sit in the PDA.

### Execute Helper (`packages/shared/src/execute.ts`)

Shared utility that wraps instructions in Core Execute:

```typescript
interface ExecuteParams {
  umi: Umi;
  agentAssetAddress: PublicKey;
  instructions: TransactionBuilder;  // inner instructions using PDA as signer
  collection?: CollectionV1;
}

export async function executeAsAgent(params: ExecuteParams): Promise<string>
```

All autonomous tools use this helper instead of calling `sendAndConfirm` directly.

## DeFi / Treasury Tools

### Jupiter Swap Helper (`packages/shared/src/jupiter.ts`)

Shared utility used by swap, buyback, and sell tools. Returns **unsigned instructions** (not a signed transaction) so they can be wrapped in `execute()`.

```typescript
interface SwapParams {
  walletAddress: string;   // The asset signer PDA (agent's operational wallet)
  inputMint: string;
  outputMint: string;
  amount: number;          // in smallest unit (lamports / token base units)
  slippageBps?: number;    // default 50 (0.5%)
}

interface SwapResult {
  signature: string;
  inputAmount: string;
  outputAmount: string;
  priceImpact: string;
}

export async function buildSwapInstructions(params: SwapParams): Promise<TransactionBuilder>
export async function executeSwap(umi: Umi, agentAssetAddress: PublicKey, params: SwapParams): Promise<SwapResult>
```

**Implementation**:
1. GET quote from `https://api.jup.ag/quote/v1` with params
2. POST to `https://api.jup.ag/swap/v1` with quote + PDA as wallet pubkey
3. Deserialize the returned instructions (not submitting directly)
4. Wrap in `executeAsAgent()` — PDA signs the swap via CPI, keypair authorizes
5. Return signature + amounts

Jupiter API key passed via `JUPITER_API_KEY` env var (optional but recommended for rate limits).

#### `swap-token` — General Token Swap

- **Input**: `inputMint` (string), `outputMint` (string), `amount` (number), `slippageBps` (number, optional)
- **Output**: `{ signature, inputAmount, outputAmount, priceImpact }`
- **Behavior**: Thin wrapper around `executeSwap`. The agent decides what to swap. Funds come from and go to the PDA.

#### `buyback-token` — Buy Back Agent's Own Token

- **Input**: `solAmount` (number, in SOL), `slippageBps` (number, optional)
- **Output**: `{ signature, solSpent, tokensReceived, priceImpact }`
- **Behavior**:
  1. Reads agent's token mint from context/config
  2. Calls `executeSwap` with SOL as input, agent token as output
  3. PDA's SOL is spent, PDA receives the agent token
  4. Returns human-readable result
- **Why separate from swap**: The system prompt gives the agent specific guidance about when and why to buy back its own token. Having a dedicated tool makes that guidance clearer.

#### `sell-token` — Sell Agent's Token Allocation

- **Input**: `tokenAmount` (number), `slippageBps` (number, optional)
- **Output**: `{ signature, tokensSold, solReceived, priceImpact }`
- **Behavior**:
  1. Reads agent's token mint from context/config
  2. Calls `executeSwap` with agent token as input, SOL as output
  3. PDA's tokens are sold, PDA receives SOL
  4. Returns human-readable result
- **Why separate**: Same reasoning — distinct system prompt guidance for selling.

## New Config / Environment

### New Env Vars

```
# Required for autonomous mode
AGENT_KEYPAIR=<base58 secret key>       # Already exists

# New for autonomous agent
AGENT_ASSET_ADDRESS=<base58 pubkey>     # Set after first registration, optional on first run
AGENT_TOKEN_MINT=<base58 pubkey>        # Set after token launch, optional on first run
```

These are optional because the agent creates them during bootstrap. Once created, they can be set in `.env` so the agent remembers across restarts.

### Config Schema Update

```typescript
// Add to envSchema:
AGENT_ASSET_ADDRESS: z.string().optional(),
AGENT_TOKEN_MINT: z.string().optional(),
```

### RequestContext Additions

```typescript
// In websocket.ts, add to RequestContext:
['agentAssetAddress', config.AGENT_ASSET_ADDRESS ?? null],
['agentTokenMint', config.AGENT_TOKEN_MINT ?? null],
```

## New Dependencies

```
packages/shared/package.json:
  + @metaplex-foundation/genesis (for token launch)
  + @metaplex-foundation/mpl-core (for execute() and findAssetSignerPda)

packages/core/package.json:
  + @metaplex-foundation/mpl-agent-registry (for registration + delegation)
  + @metaplex-foundation/mpl-core (for Core asset operations)
```

## Autonomous Agent System Prompt

The autonomous agent gets a completely different system prompt focused on:

1. **Identity awareness** — "You are an autonomous agent with your own wallet and on-chain identity"
2. **Bootstrap behavior** — Check registration status, register if needed
3. **Token launch guidance** — Confirm with user before launching (irreversible)
4. **Treasury management** — When to buy back, when to sell, risk awareness
5. **Self-funding** — After token launch, creator fees flow to the agent's PDA

Key differences from public agent prompt:
- No mention of "user's wallet" — the agent acts on its own behalf
- Emphasizes the agent's own balance and holdings
- Includes risk/caution language around irreversible actions (token launch)
- Describes the bootstrap flow so the agent knows what to do on first run

## File Changes Summary

```
packages/shared/
├── src/config.ts              # MODIFIED — add AGENT_ASSET_ADDRESS, AGENT_TOKEN_MINT
├── src/execute.ts             # NEW — Core Execute wrapper (executeAsAgent)
├── src/jupiter.ts             # NEW — Jupiter swap helper (builds instructions for execute)
├── src/index.ts               # MODIFIED — export execute + jupiter helpers
└── package.json               # MODIFIED — add @metaplex-foundation/genesis, @metaplex-foundation/mpl-core

packages/core/
├── src/agent.ts               # DELETED
├── src/create-agent.ts        # NEW — factory function
├── src/agent-public.ts        # NEW — renamed from agent.ts
├── src/agent-autonomous.ts    # NEW — autonomous agent definition
├── src/tools/
│   ├── shared/                # NEW dir — move existing shared tools here
│   ├── public/                # NEW dir — move transfer tools here
│   ├── autonomous/            # NEW dir
│   │   ├── register-agent.ts  # NEW
│   │   ├── delegate-execution.ts # NEW
│   │   ├── launch-token.ts    # NEW
│   │   ├── swap-token.ts      # NEW
│   │   ├── buyback-token.ts   # NEW
│   │   ├── sell-token.ts      # NEW
│   │   └── index.ts           # NEW
│   └── index.ts               # MODIFIED — export shared + public + autonomous sets
├── src/index.ts               # MODIFIED — export createAgent from new location
└── package.json               # MODIFIED — add mpl-agent-registry, mpl-core

packages/server/
├── src/websocket.ts           # MODIFIED — add agentAssetAddress, agentTokenMint to RequestContext
└── (no other changes)
```

## No Changes Required

- `packages/ui/` — The chat UI already renders agent messages and handles transactions. No UI changes needed for autonomous mode.
- WebSocket protocol — No new message types needed. Transaction signing in autonomous mode happens server-side (agent signs directly), so no transaction approval flow is triggered.

## Open Questions (Deferred)

- **Persistent state**: After registration, the agent should remember its asset address across restarts. For now, the user sets `AGENT_ASSET_ADDRESS` in `.env` after the first run. A future improvement could auto-write to a state file.
- **LP provisioning / staking**: Deferred to a future iteration. Developers can add these tools following the same pattern.
- **Multi-token support for swaps**: The current `swap-token` tool handles any pair. We could add convenience tools for common pairs later.
