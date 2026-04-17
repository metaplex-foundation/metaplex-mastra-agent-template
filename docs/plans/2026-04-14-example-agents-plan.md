# Example Agents Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 3 new tools (`sleep`, `get-token-price`, `get-token-metadata`) and update the agent system prompt to enable two example workflows: Price Watcher (autonomous loop) and Portfolio Analyzer (multi-step workflow).

**Architecture:** All changes are in `packages/core/`. Three new tool files follow the existing `createTool` pattern. The agent system prompt in `agent.ts` gets new sections describing both workflows. No new packages, dependencies, types, or config changes needed — Jupiter is a plain `fetch`, DAS uses existing Umi RPC, and `sleep` is a `setTimeout` wrapper.

**Tech Stack:** Mastra `createTool`, Zod schemas, Jupiter Price API v2, DAS `getAsset` RPC, native `setTimeout`

**Note on testing:** This project has no test framework configured. These tools are thin wrappers around external APIs (Jupiter, Solana RPC) and native APIs (`setTimeout`). Adding a test framework and mocking infrastructure would be over-engineering for a template project. Verification is done via `pnpm typecheck` and manual testing through the UI.

---

### Task 1: Create the `sleep` tool

**Files:**
- Create: `packages/core/src/tools/sleep.ts`

**Step 1: Create `packages/core/src/tools/sleep.ts`**

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const sleep = createTool({
  id: 'sleep',
  description:
    'Pause execution for a specified number of seconds. Use this to implement polling loops — for example, checking a token price periodically. Maximum 300 seconds (5 minutes).',
  inputSchema: z.object({
    seconds: z
      .number()
      .min(1)
      .max(300)
      .describe('Number of seconds to sleep (1–300)'),
  }),
  outputSchema: z.object({
    sleptFor: z.number(),
    resumedAt: z.string(),
  }),
  execute: async ({ seconds }) => {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return {
      sleptFor: seconds,
      resumedAt: new Date().toISOString(),
    };
  },
});
```

**Step 2: Run typecheck**

Run: `pnpm --filter @metaplex-agent/core typecheck`
Expected: No errors (file isn't imported yet, but should parse cleanly)

**Step 3: Commit**

```bash
git add packages/core/src/tools/sleep.ts
git commit -m "feat: add sleep tool for autonomous loop support"
```

---

### Task 2: Create the `get-token-price` tool

**Files:**
- Create: `packages/core/src/tools/get-token-price.ts`

**Step 1: Create `packages/core/src/tools/get-token-price.ts`**

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const getTokenPrice = createTool({
  id: 'get-token-price',
  description:
    'Get the current USD price of a Solana token by its mint address. Uses the Jupiter Price API. Returns null price if the token is not listed.',
  inputSchema: z.object({
    mintAddress: z
      .string()
      .describe('The token mint address (base58-encoded). For SOL, use "So11111111111111111111111111111111111111112".'),
  }),
  outputSchema: z.object({
    mint: z.string(),
    priceUsd: z.number().nullable(),
    source: z.string(),
  }),
  execute: async ({ mintAddress }) => {
    const url = `https://api.jup.ag/price/v2?ids=${mintAddress}`;
    const response = await fetch(url);

    if (!response.ok) {
      return {
        mint: mintAddress,
        priceUsd: null,
        source: 'jupiter',
      };
    }

    const data = (await response.json()) as {
      data: Record<string, { price: string } | undefined>;
    };

    const tokenData = data.data[mintAddress];
    const priceUsd = tokenData ? parseFloat(tokenData.price) : null;

    return {
      mint: mintAddress,
      priceUsd,
      source: 'jupiter',
    };
  },
});
```

**Step 2: Run typecheck**

Run: `pnpm --filter @metaplex-agent/core typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/core/src/tools/get-token-price.ts
git commit -m "feat: add get-token-price tool using Jupiter Price API"
```

---

### Task 3: Create the `get-token-metadata` tool

**Files:**
- Create: `packages/core/src/tools/get-token-metadata.ts`

**Step 1: Create `packages/core/src/tools/get-token-metadata.ts`**

This tool uses the DAS `getAsset` RPC method, which is available on Helius, Triton, and other DAS-enabled RPCs. It follows the same `umi.rpc.call()` pattern used in `get-transaction.ts:24-28`.

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createUmi } from '@metaplex-agent/shared';

export const getTokenMetadata = createTool({
  id: 'get-token-metadata',
  description:
    'Get metadata (name, symbol, image) for a Solana token by its mint address. Uses the DAS API. Returns null fields if metadata is unavailable.',
  inputSchema: z.object({
    mintAddress: z
      .string()
      .describe('The token mint address (base58-encoded)'),
  }),
  outputSchema: z.object({
    mint: z.string(),
    name: z.string().nullable(),
    symbol: z.string().nullable(),
    image: z.string().nullable(),
  }),
  execute: async ({ mintAddress }) => {
    const umi = createUmi();

    try {
      const asset = await umi.rpc.call<{
        content: {
          metadata: { name?: string; symbol?: string };
          links?: { image?: string };
        };
      }>('getAsset', [mintAddress]);

      return {
        mint: mintAddress,
        name: asset.content.metadata.name ?? null,
        symbol: asset.content.metadata.symbol ?? null,
        image: asset.content.links?.image ?? null,
      };
    } catch {
      return {
        mint: mintAddress,
        name: null,
        symbol: null,
        image: null,
      };
    }
  },
});
```

**Step 2: Run typecheck**

Run: `pnpm --filter @metaplex-agent/shared build && pnpm --filter @metaplex-agent/core typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/core/src/tools/get-token-metadata.ts
git commit -m "feat: add get-token-metadata tool using DAS getAsset"
```

---

### Task 4: Register all new tools

**Files:**
- Modify: `packages/core/src/tools/index.ts`

**Step 1: Update `packages/core/src/tools/index.ts`**

Replace the entire file with:

```typescript
import { getBalance } from './get-balance.js';
import { getTokenBalances } from './get-token-balances.js';
import { transferSol } from './transfer-sol.js';
import { transferToken } from './transfer-token.js';
import { getTransaction } from './get-transaction.js';
import { sleep } from './sleep.js';
import { getTokenPrice } from './get-token-price.js';
import { getTokenMetadata } from './get-token-metadata.js';

export const tools = {
  getBalance,
  getTokenBalances,
  transferSol,
  transferToken,
  getTransaction,
  sleep,
  getTokenPrice,
  getTokenMetadata,
};

export const toolNames = Object.keys(tools);
```

**Step 2: Run typecheck**

Run: `pnpm --filter @metaplex-agent/shared build && pnpm --filter @metaplex-agent/core typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/core/src/tools/index.ts
git commit -m "feat: register sleep, get-token-price, get-token-metadata tools"
```

---

### Task 5: Update the agent system prompt

**Files:**
- Modify: `packages/core/src/agent.ts:5-18` (the `SYSTEM_PROMPT` constant)

**Step 1: Replace the `SYSTEM_PROMPT` in `packages/core/src/agent.ts`**

Replace lines 5–18 with:

```typescript
const SYSTEM_PROMPT = `You are a helpful Solana blockchain assistant. You help users interact with the Solana blockchain using your available tools.

You can:
- Check SOL balances for any wallet address
- View token holdings for any wallet
- Transfer SOL between wallets
- Transfer SPL tokens between wallets
- Look up transaction details
- Get current USD prices for any Solana token
- Get token metadata (name, symbol, image)
- Sleep/pause for a specified duration (for monitoring loops)

When the user has connected their wallet, use that address as the default for operations unless they specify a different address.

When the user requests a transfer, execute it immediately — the UI and wallet will prompt for approval before signing.

## Price Watching

When the user asks you to watch, monitor, or alert on a token price:
1. Use get-token-price to check the current price
2. Report the current price with brief context
3. If the condition is not yet met, use the sleep tool to wait (default 30 seconds unless the user specifies an interval)
4. After waking, check the price again and repeat
5. When the condition is met (e.g., price crosses a threshold), alert the user clearly
6. Ask if they want to continue watching or stop
7. If the user says stop at any point, end the loop immediately

Always tell the user what you're doing: "SOL is at $195.40, still below your $200 target. Checking again in 30 seconds..."

## Portfolio Analysis

When the user asks you to analyze their portfolio:
1. Fetch their SOL balance using get-balance
2. Fetch all token holdings using get-token-balances
3. For each token found, look up its metadata (name, symbol) using get-token-metadata and its current price using get-token-price
4. Calculate the total portfolio value in USD, and the percentage allocation for each holding
5. Present a clear summary with:
   - Each holding: name/symbol, amount, USD value, % of portfolio
   - Total portfolio value
   - Observations (e.g., concentration risk, unpriced tokens)

Narrate your progress as you work through each step so the user can follow along.

If the user asks you to do something you don't have a tool for, let them know what you can help with.`;
```

**Step 2: Run typecheck**

Run: `pnpm --filter @metaplex-agent/shared build && pnpm --filter @metaplex-agent/core typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/core/src/agent.ts
git commit -m "feat: update system prompt with price watcher and portfolio analyzer workflows"
```

---

### Task 6: Build and verify

**Files:** None (verification only)

**Step 1: Full build**

Run: `pnpm build`
Expected: All packages build successfully with no errors

**Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: No type errors across any package

**Step 3: Commit (if any build artifacts or fixes needed)**

Only commit if fixes were required. Otherwise, done.

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | `sleep` tool | Create `tools/sleep.ts` |
| 2 | `get-token-price` tool | Create `tools/get-token-price.ts` |
| 3 | `get-token-metadata` tool | Create `tools/get-token-metadata.ts` |
| 4 | Register tools | Modify `tools/index.ts` |
| 5 | System prompt | Modify `agent.ts` |
| 6 | Build & verify | None |

Tasks 1–3 are independent and can be done in parallel. Task 4 depends on 1–3. Task 5 is independent of 1–4. Task 6 depends on all.
