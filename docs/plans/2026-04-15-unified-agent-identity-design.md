# Unified Agent Identity Design

## Goal

Collapse the identity distinction between public and autonomous agents. All agents register on-chain, have a keypair, a wallet (asset signer PDA), and optionally a token. The only axis of difference is transaction routing: public agents build transactions for users to sign (with a fee prepended); autonomous agents sign and submit everything themselves.

## Core Principle

**Public vs autonomous is a transaction routing mode, not an identity mode.**

Every agent has:
- A keypair (executive — authorizes `execute()` calls)
- Registration on the Metaplex Agent Registry
- An asset signer PDA (the agent's real wallet — holds funds, receives fees)
- Optionally a token (launched by the agent, or overridden via `TOKEN_OVERRIDE`)

## Fee Model (Public Mode)

Public agents fund their inference costs by prepending a small SOL transfer to every user-facing transaction. The user signs one transaction that includes both the fee and the actual operation.

- Fee amount: `AGENT_FEE_SOL` env var, default `0.001` SOL
- Fee destination: agent's asset signer PDA (derived from `AGENT_ASSET_ADDRESS`)
- Fee is only prepended when the agent is registered (has an asset address)
- Autonomous mode is unaffected — agent pays its own fees from its PDA

### Implementation in `submitOrSend`

In public mode, before serializing the transaction for the user's wallet:

1. Read `AGENT_FEE_SOL` from config
2. Derive PDA via `findAssetSignerPda(umi, { asset: agentAssetAddress })`
3. Prepend `transferSol(userWallet → PDA, feeAmount)` to the builder
4. Continue with existing serialize-and-send logic

## Token Override

`TOKEN_OVERRIDE` is an optional env var containing a token mint address. When set:

- The agent skips `launch-token` (it doesn't launch its own token)
- `buyback-token` targets the override mint instead of the agent's own token
- Primary use case: Metaplex hosted agents buying back MPLX

Resolution order for buyback target:
1. `TOKEN_OVERRIDE` env var (if set, always wins)
2. `AGENT_TOKEN_MINT` from `.env`
3. `agentTokenMint` from `agent-state.json`

## Persistent State

A new `agent-state.json` file at the project root persists agent identity across restarts. Tools write to it after key operations.

```json
{
  "agentAssetAddress": "ABC123...",
  "agentTokenMint": "DEF456..."
}
```

### State Resolution

For `AGENT_ASSET_ADDRESS` and `AGENT_TOKEN_MINT`, the config system resolves:
1. `.env` value (always wins — operator override)
2. `agent-state.json` value (auto-persisted by tools)
3. `null` (not yet registered/launched)

### Implementation (`packages/shared/src/state.ts`)

```typescript
interface AgentState {
  agentAssetAddress?: string;
  agentTokenMint?: string;
}

export function getState(): AgentState;
export function setState(updates: Partial<AgentState>): void;
```

- `getState()` reads `agent-state.json` from the workspace root (same directory-walking logic as `.env` resolution)
- `setState()` merges updates into existing state and writes back
- File is gitignored

### Tool Integration

- `register-agent`: after successful registration, calls `setState({ agentAssetAddress })`
- `launch-token`: after successful launch, calls `setState({ agentTokenMint })`

## Tool Reorganization

The `autonomous/` tool directory is eliminated. Registration, delegation, and treasury tools move to `shared/` since both modes need them.

### New Layout

```
tools/
├── shared/                    # Both modes
│   ├── get-balance.ts
│   ├── get-token-balances.ts
│   ├── get-transaction.ts
│   ├── get-token-price.ts
│   ├── get-token-metadata.ts
│   ├── sleep.ts
│   ├── register-agent.ts      # moved from autonomous/
│   ├── delegate-execution.ts   # moved from autonomous/
│   ├── launch-token.ts         # moved from autonomous/
│   ├── swap-token.ts           # moved from autonomous/
│   ├── buyback-token.ts        # moved from autonomous/
│   └── sell-token.ts           # moved from autonomous/
├── public/                    # Public mode only
│   ├── transfer-sol.ts
│   └── transfer-token.ts
└── (autonomous/ removed)
```

### Tool Assignment

- **Public mode**: `shared + public` tools
- **Autonomous mode**: `shared` tools only

`transfer-sol` and `transfer-token` remain public-only because they build transactions for the user's wallet. In autonomous mode, the agent uses `swap-token` and direct PDA operations.

## System Prompt

A single shared base prompt with a short mode-specific addendum. One source of truth, less drift.

### Shared Base

Covers:
- **Bootstrap**: "On first interaction, if you're not already registered, register yourself on the Agent Registry and delegate execution authority. Do this before anything else."
- **Identity**: "You have your own wallet (asset signer PDA) and on-chain identity."
- **Treasury management**: buyback, sell, swap guidance
- **Token launch**: confirmation warning, TOKEN_OVERRIDE awareness ("If TOKEN_OVERRIDE is configured, your buyback target is already set — do not launch a token.")
- **Read-only tools**: balance checks, price lookups, portfolio analysis
- **Price watching**: sleep-loop pattern

### Public Mode Addendum

- "When the user requests an operation, build the transaction for their wallet — they'll approve it in the UI."
- "A small fee is automatically included in each transaction to fund your operations."
- Available extra tools: transfer-sol, transfer-token

### Autonomous Mode Addendum

- "You sign and submit all transactions yourself from your operational wallet."
- No user wallet concept — agent acts on its own behalf

### Implementation

The factory function builds the prompt:

```typescript
function buildSystemPrompt(mode: AgentMode): string {
  return BASE_PROMPT + (mode === 'public' ? PUBLIC_ADDENDUM : AUTONOMOUS_ADDENDUM);
}
```

## Config & Environment Changes

### New Env Vars

```
AGENT_FEE_SOL=0.001          # SOL fee per user transaction (public mode)
TOKEN_OVERRIDE=               # Optional: mint address for buyback target (e.g., MPLX)
```

### Changed Env Vars

```
AGENT_KEYPAIR=                # Now required in BOTH modes (was "autonomous only")
AGENT_ASSET_ADDRESS=          # Optional in .env, auto-persisted to agent-state.json
AGENT_TOKEN_MINT=             # Optional in .env, auto-persisted to agent-state.json
AGENT_MODE=public             # Now only controls transaction routing, not identity
```

### Config Schema Update

```typescript
const envSchema = z.object({
  AGENT_MODE: z.enum(['public', 'autonomous']).default('public'),
  LLM_MODEL: z.string().default('anthropic/claude-sonnet-4-5-20250929'),
  SOLANA_RPC_URL: z.string().default('https://api.devnet.solana.com'),
  AGENT_KEYPAIR: z.string().min(1, 'AGENT_KEYPAIR is required'),  // now required
  AGENT_FEE_SOL: z.coerce.number().default(0.001),                 // new
  TOKEN_OVERRIDE: z.string().optional(),                            // new
  WEB_CHANNEL_PORT: z.coerce.number().default(3002),
  WEB_CHANNEL_TOKEN: z.string().min(1, 'WEB_CHANNEL_TOKEN is required'),
  ASSISTANT_NAME: z.string().default('Agent'),
  JUPITER_API_KEY: z.string().optional(),
  AGENT_ASSET_ADDRESS: z.string().optional(),  // fallback to state file
  AGENT_TOKEN_MINT: z.string().optional(),     // fallback to state file
});
```

`getConfig()` is updated to merge state file values for `AGENT_ASSET_ADDRESS` and `AGENT_TOKEN_MINT` when not set in `.env`.

## AgentContext Update

```typescript
export interface AgentContext {
  walletAddress: string | null;
  transactionSender: TransactionSender | null;
  agentMode: 'public' | 'autonomous';
  agentAssetAddress: string | null;
  agentTokenMint: string | null;
  agentFeeSol: number;          // new
  tokenOverride: string | null;  // new
}
```

## Runtime Behavior

### Bootstrap (First Run)

1. Server boots with no `AGENT_ASSET_ADDRESS` (not in `.env`, no state file yet)
2. User sends first message
3. System prompt directs agent to register before doing anything else
4. Agent calls `register-agent` → mints on Agent Registry
5. Tool writes `agentAssetAddress` to `agent-state.json`
6. Agent calls `delegate-execution` → sets up executive authority
7. Agent confirms registration, ready for normal operation
8. On restart, `getConfig()` picks up the address from state file

### Normal Operation (Public Mode)

1. User sends a message requesting a transfer
2. Agent calls `transfer-sol` tool
3. Tool calls `submitOrSend` which:
   - Reads `AGENT_ASSET_ADDRESS` from config (now available)
   - Derives asset signer PDA
   - Prepends `transferSol(user → PDA, AGENT_FEE_SOL)`
   - Appends the actual transfer instruction
   - Serializes and sends to user's wallet
4. User sees one transaction, approves it, both fee and transfer execute atomically

### Normal Operation (Autonomous Mode)

Same as before — agent signs everything with its keypair via `execute()`, no fee prepend.

## File Changes Summary

```
packages/shared/
├── src/config.ts              # MODIFIED — new env vars, state file fallback
├── src/state.ts               # NEW — read/write agent-state.json
├── src/transaction.ts         # MODIFIED — fee prepend logic in public mode
├── src/types/agent.ts         # MODIFIED — add agentFeeSol, tokenOverride
├── src/index.ts               # MODIFIED — export state helpers
└── package.json               # (no changes)

packages/core/
├── src/agent-public.ts        # MODIFIED — use shared base prompt + public addendum
├── src/agent-autonomous.ts    # MODIFIED — use shared base prompt + autonomous addendum
├── src/create-agent.ts        # MODIFIED — both modes get shared tools
├── src/prompts.ts             # NEW — shared base prompt + addendums
├── src/tools/
│   ├── shared/                # MODIFIED — gains 6 tools from autonomous/
│   │   ├── register-agent.ts
│   │   ├── delegate-execution.ts
│   │   ├── launch-token.ts
│   │   ├── swap-token.ts
│   │   ├── buyback-token.ts
│   │   ├── sell-token.ts
│   │   └── index.ts
│   ├── public/                # (unchanged)
│   │   ├── transfer-sol.ts
│   │   └── transfer-token.ts
│   ├── autonomous/            # DELETED
│   └── index.ts               # MODIFIED — no more autonomousTools export
├── src/index.ts               # MODIFIED — updated exports
└── package.json               # MODIFIED — deps move if needed

packages/server/
├── src/websocket.ts           # MODIFIED — pass new context fields (agentFeeSol, tokenOverride)
└── (no other changes)

Root:
├── agent-state.json           # NEW (auto-generated, gitignored)
├── .gitignore                 # MODIFIED — add agent-state.json
└── .env.example               # MODIFIED — updated comments, new vars
```
