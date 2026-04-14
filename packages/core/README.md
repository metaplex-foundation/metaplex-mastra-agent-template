# @metaplex-agent/core

The Mastra agent definition and Solana tool library for the Metaplex Agent Template. This package contains the AI agent, its system prompt, and a set of ready-to-use tools for interacting with the Solana blockchain.

## Overview

The core package exports two things:

- **`createAgent()`** -- creates a configured Mastra `Agent` instance with the system prompt, LLM model, and all registered tools.
- **`tools`** -- the tool registry object passed to the agent.

The agent is LLM-provider-agnostic (Anthropic, OpenAI, Google, etc.) and mode-agnostic (public or autonomous). Mode-specific behavior is handled by the shared `submitOrSend` helper at the transaction layer.

## Modifying the System Prompt

The system prompt lives at the top of `src/agent.ts`:

```typescript
// src/agent.ts

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
```

Edit this string directly to change the agent's personality, capabilities description, or behavioral guidelines. The prompt is passed to Mastra as the `instructions` field on the `Agent` constructor.

## Configuring the LLM Provider

The LLM model is set via the `LLM_MODEL` environment variable using Mastra's `provider/model` format:

```
LLM_MODEL=anthropic/claude-sonnet-4-5-20250929
LLM_MODEL=openai/gpt-4o
LLM_MODEL=google/gemini-2.5-pro
```

You must also set the corresponding API key environment variable for your chosen provider:

| Provider   | API Key Variable               |
|------------|--------------------------------|
| Anthropic  | `ANTHROPIC_API_KEY`            |
| OpenAI     | `OPENAI_API_KEY`               |
| Google     | `GOOGLE_GENERATIVE_AI_API_KEY` |

The `getConfig()` function from `@metaplex-agent/shared` reads `LLM_MODEL` and passes it to the Mastra `Agent` constructor as the `model` field.

## Included Tools

| Tool               | ID                  | Description                                                                                       |
|--------------------|---------------------|---------------------------------------------------------------------------------------------------|
| `getBalance`       | `get-balance`       | Returns the SOL balance (in SOL and lamports) for a given wallet address.                         |
| `getTokenBalances` | `get-token-balances`| Returns all SPL token holdings for a wallet, including mint, raw amount, decimals, and UI amount. |
| `transferSol`      | `transfer-sol`      | Transfers SOL to a destination address. Uses `submitOrSend` for mode-aware execution.             |
| `transferToken`    | `transfer-token`    | Transfers SPL tokens to a destination. Auto-creates the destination token account if needed.      |
| `getTransaction`   | `get-transaction`   | Looks up a transaction by its base58 signature and returns status/error information.              |

All tools are registered in `src/tools/index.ts` and exported as a single `tools` object.

## Adding a New Tool

### Step 1: Create the tool file

Create a new file in `src/tools/`, for example `src/tools/my-new-tool.ts`:

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createUmi } from '@metaplex-agent/shared';

export const myNewTool = createTool({
  id: 'my-new-tool',
  description:
    'A clear description of what this tool does. The LLM reads this to decide when to call it.',
  inputSchema: z.object({
    address: z
      .string()
      .describe('The Solana wallet address (base58-encoded public key)'),
    // Add more input parameters as needed
  }),
  outputSchema: z.object({
    result: z.string(),
    // Define the shape of your return value
  }),
  execute: async ({ address }) => {
    const umi = createUmi();

    // Your tool logic here -- use Umi for Solana interactions
    const result = `Processed ${address}`;

    return { result };
  },
});
```

### Step 2: Register the tool

Add it to the tool registry in `src/tools/index.ts`:

```typescript
import { getBalance } from './get-balance.js';
import { getTokenBalances } from './get-token-balances.js';
import { transferSol } from './transfer-sol.js';
import { transferToken } from './transfer-token.js';
import { getTransaction } from './get-transaction.js';
import { myNewTool } from './my-new-tool.js';

export const tools = {
  getBalance,
  getTokenBalances,
  transferSol,
  transferToken,
  getTransaction,
  myNewTool,
};
```

### Step 3: Update the system prompt (optional)

If the tool represents a new capability, mention it in the system prompt in `src/agent.ts` so the LLM knows it is available.

## Accessing AgentContext in Tools

Tools that need access to the connected wallet address, transaction sender, or agent mode must extract these from the Mastra `requestContext`. The server injects these values when it invokes the agent.

Here is the pattern used by the transaction tools (`transfer-sol.ts`, `transfer-token.ts`):

```typescript
import {
  createUmi,
  submitOrSend,
  type AgentContext,
} from '@metaplex-agent/shared';
import type { RequestContext } from '@mastra/core/request-context';

export const myTransactionTool = createTool({
  id: 'my-transaction-tool',
  description: '...',
  inputSchema: z.object({ /* ... */ }),
  outputSchema: z.object({
    status: z.string(),
    signature: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ /* inputs */ }, { requestContext }) => {
    // Extract the AgentContext from the Mastra RequestContext
    const ctx = requestContext as RequestContext<AgentContext> | undefined;
    const context: AgentContext = {
      walletAddress: ctx?.get('walletAddress') ?? null,
      transactionSender: ctx?.get('transactionSender') ?? null,
      agentMode: ctx?.get('agentMode') ?? 'public',
    };

    // Now you can use context.walletAddress, context.agentMode, etc.
  },
});
```

The three context fields are:

| Field               | Type                       | Description                                          |
|---------------------|----------------------------|------------------------------------------------------|
| `walletAddress`     | `string \| null`           | The connected user's Solana wallet address, or null.  |
| `transactionSender` | `TransactionSender \| null`| Interface for sending transactions to the frontend.   |
| `agentMode`         | `'public' \| 'autonomous'` | The current agent mode from configuration.            |

## Using submitOrSend in Transaction Tools

For any tool that builds a Solana transaction, use the shared `submitOrSend` helper. It handles the branching logic between public and autonomous modes:

```typescript
const umi = createUmi();

// Build a transaction using Umi
const builder = transferSolIx(umi, {
  source: umi.identity,
  destination: publicKey(destination),
  amount: sol(amount),
});

// Submit or send based on the agent mode
const result = await submitOrSend(umi, builder, context, {
  message: `Transfer ${amount} SOL to ${destination}`,
});

if (result === 'sent-to-wallet') {
  // Public mode: transaction was sent to the frontend for signing
  return {
    status: 'pending',
    message: 'Transaction sent to your wallet for signing.',
  };
}

// Autonomous mode: transaction was signed and submitted
return {
  status: 'confirmed',
  signature: result,
  message: `Transaction confirmed. Signature: ${result}`,
};
```

**Public mode behavior**: The transaction is serialized to base64 with the user's wallet set as fee payer (via a noop signer), then pushed to the frontend over the WebSocket. The tool returns `'sent-to-wallet'`.

**Autonomous mode behavior**: The transaction is signed with the agent's keypair and submitted directly to the Solana RPC. The tool returns the base58 transaction signature.

## File Structure

```
packages/core/
  src/
    agent.ts                 # Agent definition + system prompt
    index.ts                 # Package exports
    tools/
      index.ts               # Tool registry
      get-balance.ts         # SOL balance lookup
      get-token-balances.ts  # SPL token holdings
      get-transaction.ts     # Transaction status lookup
      transfer-sol.ts        # SOL transfer
      transfer-token.ts      # SPL token transfer
  package.json
```
