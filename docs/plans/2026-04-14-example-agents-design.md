# Example Agents Design: Price Watcher & Portfolio Analyzer

## Goal

Add two "Hello World" style examples that demonstrate long-running agent patterns using the existing agent template architecture. No structural changes to the monorepo — just new tools and an updated system prompt.

## Examples

### 1. Price Watcher (Autonomous Loop)

Demonstrates an agent-driven loop where the agent controls its own lifecycle using a `sleep` tool.

**User flow:**
1. User: "Watch SOL price, alert me if it goes above $200"
2. Agent calls `get-token-price` to check current price
3. Agent evaluates condition (above/below threshold?)
4. Agent calls `sleep` tool with a duration (e.g., 30s)
5. Sleep resolves — agent wakes up, goes back to step 2
6. When condition triggers, agent pushes an alert message
7. Agent decides whether to keep watching or stop

**Key behaviors:**
- Agent decides loop cadence and exit conditions
- Agent narrates what it's doing each iteration ("SOL at $195.40, still below $200. Checking again in 30s...")
- User can interrupt with "stop watching" at any point
- Works in both public and autonomous modes (read-only operation)

### 2. Portfolio Analyzer (Multi-Step Workflow)

Demonstrates a complex plan executed across many tool calls, where each step builds on the previous.

**User flow:**
1. User: "Analyze my portfolio"
2. **Gather** — Agent fetches SOL balance + all token holdings (existing tools)
3. **Enrich** — For each token, agent looks up metadata (name, symbol) and current price
4. **Calculate** — Agent computes total value, per-token allocation %, largest/smallest positions
5. **Summarize** — Agent presents formatted breakdown with observations

**Key behaviors:**
- Agent chains existing tools (get-balance, get-token-balances) with new ones
- Agent reasons between steps (decides which tokens to price, handles missing data)
- Agent narrates progress ("Found 5 tokens, looking up prices...")
- Final output is a structured analysis, not raw data dumps

## New Tools

### `sleep` — Autonomous Loop Primitive

- **Input:** `seconds` (number, 1–300)
- **Output:** `{ resumedAt: string }` (ISO timestamp)
- **Implementation:** Wraps `setTimeout` in a promise
- **Purpose:** Gives the agent control over its own loop timing

### `get-token-price` — Token Price Lookup

- **Input:** `mintAddress` (string, base58)
- **Output:** `{ mint: string, priceUsd: number | null, source: string }`
- **Data source:** Jupiter Price API v2 (`https://api.jup.ag/price/v2?ids=<mint>`)
- **Shared by:** Both Price Watcher and Portfolio Analyzer
- **Notes:**
  - Free, no auth required
  - Supports any Solana token
  - Returns null price if token not found on Jupiter
  - Well-known mints (SOL, USDC) should use their actual mint addresses

### `get-token-metadata` — Token Metadata Lookup

- **Input:** `mintAddress` (string, base58)
- **Output:** `{ mint: string, name: string | null, symbol: string | null, image: string | null }`
- **Data source:** DAS API via `umi.rpc.call('getAsset', ...)` or equivalent
- **Used by:** Portfolio Analyzer only
- **Notes:**
  - Requires RPC that supports DAS (Helius, Triton, etc.)
  - Returns nulls gracefully if metadata unavailable
  - Single call returns name, symbol, and image

## System Prompt Updates

Add sections to the existing agent system prompt covering:

**Price watching behavior:**
- When asked to watch/monitor a price, use `get-token-price` + `sleep` in a loop
- Report current price each iteration with brief context
- Alert clearly when threshold is crossed
- Stop when user asks or condition is met
- Default to 30-second intervals unless user specifies otherwise

**Portfolio analysis behavior:**
- When asked to analyze a portfolio, follow the gather → enrich → calculate → summarize workflow
- Narrate each step so the user sees progress
- Handle missing price data gracefully (note tokens that couldn't be priced)
- Present final analysis with allocation percentages and observations

## File Changes

```
packages/core/src/tools/
├── sleep.ts                # NEW
├── get-token-price.ts      # NEW
├── get-token-metadata.ts   # NEW
└── index.ts                # MODIFIED — register 3 new tools

packages/core/src/agent.ts  # MODIFIED — updated system prompt
```

## No Changes Required

- No changes to `packages/shared/` (no new types or config needed)
- No changes to `packages/server/` (WebSocket protocol already handles streaming)
- No changes to `packages/ui/` (chat UI already renders agent messages)
- No new dependencies (Jupiter is a plain HTTP fetch, DAS uses existing Umi RPC)
