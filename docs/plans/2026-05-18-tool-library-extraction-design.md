# Tool Library Extraction — Design

**Date:** 2026-05-18
**Status:** Approved, in implementation

## Problem

Tools, agent runtime (umi factory, config, state, auth, jupiter, banner), and
agent-assembly code all live inside `014-agent-template`'s `packages/core` and
`packages/shared`. Every new agent we build today must either fork the repo or
re-copy the tools. There is no way to install a curated tool set into a fresh
Mastra agent.

We want a separate, reusable library that:

1. Ships the tool catalog and supporting runtime.
2. Lets a new agent pick which tools to enable without editing source.
3. Stays Metaplex-first but doesn't drag transport-layer concerns (SIWS,
   allowlist, PlexChat protocol types) into consumers that don't need them.

## Outcome

A new sibling repository `metaplex-agent-toolkit/` with two packages:

- `@metaplex-foundation/agent-runtime` — umi factory, config loader,
  `agent-state.json` IO, auth wrapper + policy, jupiter client, swap
  pre-simulation, registration banner, transaction/funding helpers, error
  helpers, agent-context type, tool-result helpers.
- `@metaplex-foundation/agent-tools` — every tool currently in
  `packages/core/src/tools/`, plus a `defineTool` authoring helper, a
  capability enum, a `createToolset({ include, exclude, authPolicy })` builder,
  and named bundles (`readOnlyBundle`, `tradingBundle`, etc.).

The existing `014-agent-template` stops shipping its own copies of the runtime
and tools; it imports them from the new packages instead. `packages/shared`
shrinks to transport-only concerns (SIWS, allowlist, nonce-store, protocol
types, server-limits). `packages/core` shrinks to agent assembly (persona
loading, prompt builder, `createAgent()`) wired against the toolkit.

## Audience and scope

**Audience:** Metaplex-first but open. Tools may freely depend on
`@metaplex-foundation/*` SDKs (Umi, mpl-core, mpl-agent-registry, genesis,
toolbox), but the toolkit must not depend on `014-agent-template`,
PlexChat-specific types, SIWS, the allowlist, or the WebSocket server.

**Not in scope right now:**

- Adapters for non-Mastra frameworks (Agent SDK, raw OpenAI). The
  `defineTool` shape leaves room for one later, but we don't ship it.
- Dependency injection per tool (pure functions taking `{umi, state}`).
  Today's process-global singletons stay; tools keep calling `getConfig()`
  and `createUmi()`. The toolkit owns those singletons going forward.
- Per-tool fine-grained packages. One `agent-tools` package; selection is
  handled by the builder, not by importing different packages.

## Architecture

### Package layout

```text
metaplex-agent-toolkit/
├── package.json          # workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── README.md
├── .npmrc                # shamefully-hoist=true for umi deps
└── packages/
    ├── runtime/
    │   ├── package.json  # @metaplex-foundation/agent-runtime
    │   ├── tsconfig.json
    │   ├── src/
    │   │   ├── index.ts
    │   │   ├── config.ts             # getConfig(), env schema
    │   │   ├── umi.ts                # createUmi()
    │   │   ├── state.ts              # agent-state.json IO
    │   │   ├── auth.ts               # withAuth, AuthPolicy, resolveOwner
    │   │   ├── jupiter.ts            # executeSwap, simulateAndVerifySwap
    │   │   ├── transaction.ts        # tx build helpers
    │   │   ├── funding.ts            # SOL funding helpers
    │   │   ├── execute.ts            # tx submit + confirm
    │   │   ├── error-codes.ts        # ToolErrorCode enum
    │   │   ├── registration-banner.ts
    │   │   ├── paas.ts               # platform detection (Railway, etc.)
    │   │   ├── agent-config.ts       # AGENT_PERSONA + yaml config
    │   │   └── types/
    │   │       ├── agent.ts          # AgentContext
    │   │       └── tool-result.ts    # ok/info/err helpers
    │   └── test/
    │       ├── unit/
    │       └── integration/
    └── tools/
        ├── package.json  # @metaplex-foundation/agent-tools
        ├── tsconfig.json
        ├── src/
        │   ├── index.ts              # public API
        │   ├── capabilities.ts       # Capability enum + types
        │   ├── define-tool.ts        # defineTool() authoring helper
        │   ├── toolset.ts            # createToolset() builder
        │   ├── bundles.ts            # readOnlyBundle, tradingBundle, etc.
        │   ├── registry.ts           # internal: tool metadata registry
        │   └── tools/
        │       ├── get-balance.ts
        │       ├── get-token-balances.ts
        │       ├── get-transaction.ts
        │       ├── get-token-price.ts
        │       ├── get-token-metadata.ts
        │       ├── sleep.ts
        │       ├── fund-agent-sol.ts
        │       ├── register-agent.ts
        │       ├── delegate-execution.ts
        │       ├── launch-token.ts
        │       ├── swap-token.ts
        │       ├── buyback-token.ts
        │       ├── sell-token.ts
        │       ├── transfer-sol.ts
        │       ├── transfer-token.ts
        │       ├── goals-tasks.ts    # 4 tools
        │       ├── set-paused.ts
        │       └── withdraw-sol.ts
        └── test/
            ├── unit/
            └── integration/
```

22 tool files map to 21 source files because `goals-tasks.ts` already groups 4
tools in one file.

### Tool authoring shape

Today tools are written with `createTool` from `@mastra/core/tools` and wrapped
with `withAuth(tool, 'public')` at registration time. We replace that with a
single helper:

```ts
// packages/tools/src/tools/get-balance.ts
import { z } from 'zod';
import { defineTool, BASE58_ADDRESS_RE, createUmi, ok, err, toToolError }
  from '@metaplex-foundation/agent-runtime';

export const getBalance = defineTool({
  id: 'get-balance',
  description: 'Get the SOL balance of a Solana wallet address...',
  authLevel: 'public',
  requires: ['umi-rpc'],
  category: 'read',
  inputSchema: z.object({
    address: z.string().regex(BASE58_ADDRESS_RE),
  }),
  outputSchema: z.object({ /* ... */ }),
  execute: async ({ address }) => { /* ... */ },
});
```

`defineTool` returns a `ToolDefinition` — a plain object that carries the
Mastra tool (built via `createTool` internally) plus the metadata
(`authLevel`, `requires`, `category`, `id`). It does *not* apply `withAuth`
itself — that happens at toolset-build time so the consumer's auth policy is
respected.

### Capabilities

A small fixed enum, declared statically per tool:

```ts
export type Capability =
  | 'umi-rpc'           // basic RPC reads
  | 'agent-keypair'     // AGENT_KEYPAIR signs txs
  | 'agent-identity'    // agent has been registered (AGENT_ASSET_ADDRESS)
  | 'agent-token'       // agent has launched / been bound to a token
  | 'jupiter'           // Jupiter swap API reachable
  | 'genesis'           // Metaplex Genesis SDK (token launches)
  | 'registry'          // Agent Registry program
  | 'state-store'       // agent-state.json read/write
  | 'banner';           // stderr registration banner (PaaS detection)
```

When `createToolset({ capabilities, include })` is called, the builder
verifies that every included tool's `requires` is a subset of `capabilities`.
Missing capabilities throw a clear error at build time, not at first invoke.

The default `capabilities` (if not specified) is "all" — same fail-at-runtime
behavior as today, no surprise breakage for the template's migration.

### Builder API

```ts
import { createToolset } from '@metaplex-foundation/agent-tools';
import { customAuthPolicy } from './my-policy';

const tools = createToolset({
  // Either an explicit list, '*', or category selectors like 'category:read'
  include: ['get-balance', 'swap-token', 'category:autonomous-only'],
  exclude: ['withdraw-sol'],

  // Optional. Defaults to public/owner policy from runtime.
  authPolicy: customAuthPolicy,

  // Optional. Defaults to declaring all capabilities (today's behavior).
  capabilities: ['umi-rpc', 'jupiter', 'agent-keypair'],
});

new Agent({ tools, /* ... */ });
```

Returns a `Record<string, Tool>` — drop-in for Mastra's `Agent({ tools })`.
Each tool in the record has had `withAuth(tool, authLevel, policy)` applied.

### Bundles

Sugar on top of the builder for common shapes:

```ts
export const readOnlyBundle = createToolset({
  include: ['category:read'],
});

export const tradingBundle = createToolset({
  include: ['swap-token', 'buyback-token', 'sell-token'],
});

export const registrationBundle = createToolset({
  include: ['register-agent', 'delegate-execution', 'launch-token'],
});

// Mirror today's behavior exactly
export const publicBundle = createToolset({
  exclude: ['category:autonomous-only'],
});
export const autonomousBundle = createToolset({
  exclude: ['transfer-sol', 'transfer-token'],
});
```

Bundles are pre-built `Record<string, Tool>` objects, ready to spread:
`new Agent({ tools: { ...readOnlyBundle, ...tradingBundle } })`.

### Categories

Used for `category:X` selectors in `include`/`exclude`. Each tool declares
exactly one:

- `read` — RPC reads, no tx, no state mutation
- `transfer` — user-signed transfers (public-mode-friendly)
- `trade` — Jupiter swaps (agent-signed)
- `treasury` — withdraw, fund — moving funds owned by the agent
- `registration` — register-agent, delegate-execution, launch-token
- `autonomous-only` — goals, tasks, paused (working-memory toggles)
- `utility` — sleep

## Data flow

No change to how tools execute. Mastra `Agent` calls `tool.execute(args, { requestContext })`.
The tool reads `walletAddress` / `ownerWallet` / `agentAssetAddress` etc.
from `requestContext` exactly as today. `withAuth` runs first; the tool body
runs second.

The only behavioral change is at *assembly* time: instead of importing
`publicAgentTools` from `core/tools`, the consumer either spreads a bundle
or calls the builder.

## Error handling

- `defineTool` validates required fields at module load — missing `id`,
  `authLevel`, `requires`, `category`, or `execute` throws synchronously.
- `createToolset` validates `include`/`exclude` references at call time —
  unknown tool ids throw with the list of valid ids.
- `createToolset` validates capabilities — listing a tool whose `requires`
  isn't satisfied by `capabilities` throws with the missing caps named.
- Tools still use `ok` / `info` / `err` from runtime to return structured
  results. Unchanged.

## Migration plan for 014-agent-template

Two passes to keep risk low:

**Pass 1** — toolkit stands alone. Build and test
`metaplex-agent-toolkit` in isolation. `014-agent-template` is untouched and
still works.

**Pass 2** — template consumes toolkit. Update
`014-agent-template/packages/shared` to re-export runtime bits from
`@metaplex-foundation/agent-runtime` (or have downstream code import directly
from the new package). Replace
`packages/core/src/tools/` with a thin shim that re-exports from
`@metaplex-foundation/agent-tools` bundles. Delete duplicated source files
(`umi.ts`, `config.ts`, `state.ts`, `auth.ts`, `jupiter.ts`, `transaction.ts`,
`funding.ts`, `execute.ts`, `error-codes.ts`, `registration-banner.ts`,
`paas.ts`, `agent-config.ts`, `types/agent.ts`, `types/tool-result.ts` from
`shared`; all 22 tool files from `core/tools/`).

`packages/shared` after Pass 2 keeps:

- `siws.ts`, `nonce-store.ts`, `allowlist.ts`, `allowlist-file.ts`,
  `wallet-rate-limit.ts` (transport / auth-handshake)
- `types/protocol.ts` (PlexChat protocol types)
- `server-limits.ts` (HTTP/WS limits)
- `context.ts` (RequestContext keys — may move to runtime if tools also use them)

`packages/core` after Pass 2 keeps:

- `personas/` (prompt fragments, repo-specific)
- `prompts.ts` (system prompt assembly)
- `create-agent.ts`, `agent-public.ts`, `agent-autonomous.ts` — but the
  `tools:` field comes from `publicBundle` / `autonomousBundle` imports.

### Linking strategy during development

The toolkit will be developed in a sibling directory. During Pass 1 it builds
and tests independently. For Pass 2, we use pnpm's `file:` protocol or a
`workspace` link via a new top-level `pnpm-workspace.yaml` that includes both
repos. Concretely:

- Easiest: publish the runtime + tools packages to a local registry (verdaccio
  or pnpm pack), or
- Simpler still: temporarily add `"link:../metaplex-agent-toolkit/packages/runtime"`
  to `014-agent-template`'s `package.json` while iterating. The toolkit gets
  a real npm publish later.

Pass 2 will use `link:` for the migration commit so the template builds
end-to-end without needing a publish first.

## Testing

The toolkit ports the existing test infrastructure:

- `node --test`, `tsx` loader, `nock` for HTTP mocks.
- Same `test/{unit,integration}` layout per package.
- Helpers: `mock-rpc`, `env-isolation`, `stub-agent` (currently in
  `packages/{core,shared}/test/helpers/`) move into a third internal-only
  package `@metaplex-foundation/agent-toolkit-testing` *if* they're substantial.
  Start by just duplicating the relevant helpers per package, extract later
  if the duplication hurts.
- Coverage gate not enforced inside the toolkit initially; the template's
  85% gate continues to cover the end-to-end flow.

E2E tests stay in `014-agent-template/packages/server/` — they're testing the
WebSocket protocol, not the tools.

## Risks and mitigations

1. **Singleton drift.** If `014-agent-template/shared` vendors its own
   `getConfig()` *and* the toolkit ships one, env vars are read twice and
   could disagree. *Mitigation:* in Pass 2 the template's `shared` does NOT
   keep its own copy — it re-exports from runtime. Single source of truth.

2. **Mastra metadata loss.** `withAuth` mutates the tool in place because
   Mastra attaches non-enumerable metadata after registration. The builder
   must preserve that — i.e., apply `withAuth` to the same object reference
   that the builder returns, not a shallow clone. *Mitigation:* the existing
   `withAuth` already mutates in place; we keep that contract.

3. **Capability false positives.** Declaring a capability the host can't
   actually deliver (e.g., listing `'jupiter'` when the network blocks the
   Jupiter API) won't be caught at build time. *Mitigation:* capabilities
   are intent declarations only; runtime errors still happen if the
   external service is down. We do not promise health checks.

4. **PaaS-specific runtime bits (`paas.ts`, registration banner) feel
   out of place in a tool runtime.** They are — but tools today reach for
   them (`launch-token` prints a banner). Keep them in runtime for now,
   reconsider once a non-PaaS consumer exists.

## Open questions deferred

- Should the toolkit ship its own keypair-loading helpers, or assume the host
  has already loaded one and made Umi available via the runtime singleton?
  Today the host (template) loads `AGENT_KEYPAIR` at boot; the toolkit just
  reads from `getConfig()`. We keep this contract.
- Versioning policy (semver, changesets, release process) — postpone until
  the first external consumer.
