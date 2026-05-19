# Tool Library Extraction — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract tools and agent runtime from `014-agent-template` into a sibling repo `metaplex-agent-toolkit` exposing two packages — `@metaplex-foundation/agent-runtime` and `@metaplex-foundation/agent-tools` — with a builder API that lets consumers pick tools by id / category / bundle.

**Architecture:** pnpm monorepo, ESM, tsc-built. Runtime owns process-global singletons (`getConfig`, `getState`, `createUmi`, `withAuth`, jupiter, banner, etc.). Tools depend on runtime; each tool is authored with `defineTool({ id, authLevel, requires, category, ... })`. `createToolset({ include, exclude, capabilities, authPolicy })` produces the `Record<string, Tool>` for `new Agent({ tools })`. Named bundles wrap the builder for ergonomic defaults.

**Tech Stack:** TypeScript 6, Node 22+, pnpm 10, `@mastra/core`, `@metaplex-foundation/umi`, `@metaplex-foundation/mpl-*`, `zod`, `bs58`, `nock`, `tsx`, `node --test`.

**Two passes:**
- **Pass 1 (Tasks 1–14)** — build `metaplex-agent-toolkit` standing alone. Template untouched.
- **Pass 2 (Tasks 15–19)** — migrate `014-agent-template` to consume the toolkit via `link:`, delete duplicated source.

---

## Pass 1 — Build the toolkit

### Task 1: Scaffold the new repo

**Files:**
- Create: `/Users/kelliott/Metaplex/AI/UsefulAgents/metaplex-agent-toolkit/package.json`
- Create: `/Users/kelliott/Metaplex/AI/UsefulAgents/metaplex-agent-toolkit/pnpm-workspace.yaml`
- Create: `/Users/kelliott/Metaplex/AI/UsefulAgents/metaplex-agent-toolkit/tsconfig.base.json`
- Create: `/Users/kelliott/Metaplex/AI/UsefulAgents/metaplex-agent-toolkit/.npmrc` (`shamefully-hoist=true`)
- Create: `/Users/kelliott/Metaplex/AI/UsefulAgents/metaplex-agent-toolkit/.gitignore`
- Create: `/Users/kelliott/Metaplex/AI/UsefulAgents/metaplex-agent-toolkit/README.md`

**Steps:**
1. `mkdir -p /Users/kelliott/Metaplex/AI/UsefulAgents/metaplex-agent-toolkit/packages/{runtime,tools}/src`
2. Write root `package.json` (private, workspaces in `packages/*`, scripts: `build`, `test`, `typecheck`, `clean`).
3. Write `pnpm-workspace.yaml` with `packages/*`.
4. Write `tsconfig.base.json` with `module: nodenext`, `target: es2022`, `declaration: true`, `strict: true`.
5. Write `.npmrc` and `.gitignore` (`node_modules`, `dist`, `coverage`, `.tsbuildinfo`).
6. `git init` inside `metaplex-agent-toolkit/`.
7. Commit: `chore: scaffold metaplex-agent-toolkit monorepo`.

### Task 2: Create the runtime package skeleton

**Files:**
- Create: `metaplex-agent-toolkit/packages/runtime/package.json` (name: `@metaplex-foundation/agent-runtime`)
- Create: `metaplex-agent-toolkit/packages/runtime/tsconfig.json` (extends base, `outDir: dist`)
- Create: `metaplex-agent-toolkit/packages/runtime/src/index.ts` (empty re-exports for now)

Dependencies (runtime/package.json):
```json
{
  "dependencies": {
    "@metaplex-foundation/mpl-core": "^1.9.1",
    "@metaplex-foundation/mpl-toolbox": "^0.10.0",
    "@metaplex-foundation/umi": "^1.1.0",
    "@metaplex-foundation/umi-bundle-defaults": "^1.1.0",
    "bs58": "^5.0.0",
    "dotenv": "^17.0.0",
    "yaml": "^2.5.0",
    "zod": "^3.23.0"
  },
  "devDependencies": { "tsx": "^4.21.0", "typescript": "^6.0.2" }
}
```

(Pull exact versions from `014-agent-template/packages/shared/package.json`.)

`pnpm install` once after this task to materialize node_modules.

Commit: `feat(runtime): package skeleton`.

### Task 3: Copy runtime source from `shared/`

**Files (copy from `014-agent-template/packages/shared/src/`):**
- `config.ts`, `state.ts`, `umi.ts`, `auth.ts`, `jupiter.ts`, `transaction.ts`, `funding.ts`, `execute.ts`, `error-codes.ts`, `registration-banner.ts`, `paas.ts`, `agent-config.ts`, `context.ts`
- `types/agent.ts`, `types/tool-result.ts`

**Steps:**
1. Copy each file verbatim to `metaplex-agent-toolkit/packages/runtime/src/` (preserve `types/` subdir).
2. No import changes needed — all internal imports were already relative.
3. Write `runtime/src/index.ts`:
   ```ts
   export * from './config.js';
   export * from './state.js';
   export * from './umi.js';
   export * from './auth.js';
   export * from './jupiter.js';
   export * from './transaction.js';
   export * from './funding.js';
   export * from './execute.js';
   export * from './error-codes.js';
   export * from './registration-banner.js';
   export * from './paas.js';
   export * from './agent-config.js';
   export * from './context.js';
   export * from './types/agent.js';
   export {
     ok, info, err,
     type ToolResult, type ToolSuccess, type ToolInfo, type ToolError,
     type ToolErrorCode as ToolResultErrorCode,
   } from './types/tool-result.js';
   ```
4. `pnpm --filter @metaplex-foundation/agent-runtime build`.
5. Expected: clean tsc build. Fix any missing deps.
6. Commit: `feat(runtime): port shared runtime modules`.

### Task 4: Port shared/`test/helpers/` slice the runtime uses

**Files:**
- Copy: `014-agent-template/packages/shared/test/helpers/mock-rpc.ts` → `metaplex-agent-toolkit/packages/runtime/test/helpers/mock-rpc.ts`
- Copy: `014-agent-template/packages/shared/test/helpers/env-isolation.ts` → `metaplex-agent-toolkit/packages/runtime/test/helpers/env-isolation.ts`

(Check which helper files exist; copy whichever are needed by the unit tests below.)

Commit: `test(runtime): port test helpers`.

### Task 5: Port the runtime unit tests

**Files:**
- Copy `014-agent-template/packages/shared/test/unit/*` → `metaplex-agent-toolkit/packages/runtime/test/unit/`
- Copy `014-agent-template/packages/shared/test/integration/*` → `metaplex-agent-toolkit/packages/runtime/test/integration/`

Adjust import paths only if any reference `@metaplex-foundation/shared` directly — change to relative imports of the runtime's `src/`.

Run:
```
pnpm --filter @metaplex-foundation/agent-runtime test
```
Expected: tests pass (same green output you get in the template today).

Commit: `test(runtime): port unit + integration tests`.

### Task 6: Create the tools package skeleton

**Files:**
- Create: `metaplex-agent-toolkit/packages/tools/package.json` (name: `@metaplex-foundation/agent-tools`)
- Create: `metaplex-agent-toolkit/packages/tools/tsconfig.json`
- Create: `metaplex-agent-toolkit/packages/tools/src/index.ts` (empty for now)

Dependencies (tools/package.json):
```json
{
  "dependencies": {
    "@mastra/core": "^1.24.0",
    "@metaplex-foundation/agent-runtime": "workspace:*",
    "@metaplex-foundation/genesis": "^0.35.0",
    "@metaplex-foundation/mpl-agent-registry": "^0.2.5",
    "@metaplex-foundation/mpl-core": "^1.9.1",
    "@metaplex-foundation/mpl-toolbox": "^0.10.0",
    "@metaplex-foundation/umi": "^1.1.0",
    "@noble/hashes": "1.7.1",
    "zod": "^3.23.0"
  },
  "devDependencies": { "tsx": "^4.21.0", "typescript": "^6.0.2", "nock": "^14.0.15" }
}
```

`pnpm install`. Commit: `feat(tools): package skeleton`.

### Task 7: Implement `Capability` enum and types

**File:** `metaplex-agent-toolkit/packages/tools/src/capabilities.ts`

```ts
export type Capability =
  | 'umi-rpc'
  | 'agent-keypair'
  | 'agent-identity'
  | 'agent-token'
  | 'jupiter'
  | 'genesis'
  | 'registry'
  | 'state-store'
  | 'banner';

export const ALL_CAPABILITIES: Capability[] = [
  'umi-rpc', 'agent-keypair', 'agent-identity', 'agent-token',
  'jupiter', 'genesis', 'registry', 'state-store', 'banner',
];

export type ToolCategory =
  | 'read'
  | 'transfer'
  | 'trade'
  | 'treasury'
  | 'registration'
  | 'autonomous-only'
  | 'utility';
```

Commit: `feat(tools): capability + category types`.

### Task 8: Implement `defineTool` and the internal tool registry

**Files:**
- `packages/tools/src/define-tool.ts`
- `packages/tools/src/registry.ts`

```ts
// define-tool.ts
import { createTool, type ToolAction } from '@mastra/core/tools';
import type { z } from 'zod';
import type { Capability, ToolCategory } from './capabilities.js';
import { registerTool } from './registry.js';

export interface ToolDefinition {
  id: string;
  authLevel: string;       // 'public' | 'owner' | custom
  requires: Capability[];
  category: ToolCategory;
  tool: ToolAction<any, any, any>;
}

export interface DefineToolArgs<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  id: string;
  description: string;
  authLevel: string;
  requires: Capability[];
  category: ToolCategory;
  inputSchema: I;
  outputSchema: O;
  execute: (
    args: z.infer<I>,
    ctx: { requestContext?: any },
  ) => Promise<z.infer<O>>;
}

export function defineTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  args: DefineToolArgs<I, O>,
): ToolDefinition {
  const tool = createTool({
    id: args.id,
    description: args.description,
    inputSchema: args.inputSchema,
    outputSchema: args.outputSchema,
    execute: args.execute as any,
  });
  const def: ToolDefinition = {
    id: args.id,
    authLevel: args.authLevel,
    requires: args.requires,
    category: args.category,
    tool,
  };
  registerTool(def);
  return def;
}
```

```ts
// registry.ts
import type { ToolDefinition } from './define-tool.js';

const _registry = new Map<string, ToolDefinition>();

export function registerTool(def: ToolDefinition): void {
  if (_registry.has(def.id)) {
    throw new Error(`Tool already registered: ${def.id}`);
  }
  _registry.set(def.id, def);
}

export function getRegisteredTool(id: string): ToolDefinition | undefined {
  return _registry.get(id);
}

export function listRegisteredTools(): ToolDefinition[] {
  return Array.from(_registry.values());
}

// Test helper — never call in production code.
export function _resetRegistryForTests(): void {
  _registry.clear();
}
```

Commit: `feat(tools): defineTool + internal registry`.

### Task 9: Port all 18 tool source files

**Files (copy from `014-agent-template/packages/core/src/tools/`):**

shared/:
- `get-balance.ts`, `get-token-balances.ts`, `get-transaction.ts`,
  `get-token-price.ts`, `get-token-metadata.ts`, `sleep.ts`,
  `fund-agent-sol.ts`, `register-agent.ts`, `delegate-execution.ts`,
  `launch-token.ts`, `swap-token.ts`, `buyback-token.ts`, `sell-token.ts`

public/:
- `transfer-sol.ts`, `transfer-token.ts`

autonomous/:
- `goals-tasks.ts`, `set-paused.ts`, `withdraw-sol.ts`

Destination: `packages/tools/src/tools/<name>.ts` (flat — no subdirs).

**Per-file rewrites:**
1. Change `import { createTool } from '@mastra/core/tools'` AND
   `import { ... } from '@metaplex-foundation/shared'` to a single
   `import { defineTool, <runtime exports> } from '@metaplex-foundation/agent-runtime';`
   …actually `defineTool` lives in `@metaplex-foundation/agent-tools` —
   so the file pulls runtime symbols from `@metaplex-foundation/agent-runtime`
   and `defineTool` from a sibling internal path. Use relative import:
   `import { defineTool } from '../define-tool.js';`
2. Replace `export const X = createTool({...})` with
   `export const X = defineTool({ ...sameFields, authLevel, requires, category });`
   Drop the `id`/`description`/`inputSchema`/`outputSchema`/`execute`
   keys as-is into `defineTool`; add the three metadata fields.
3. Capability + category map (apply per tool):

| Tool                  | category          | requires                                          | authLevel |
|---                    |---                |---                                                |---        |
| get-balance           | read              | umi-rpc                                           | public    |
| get-token-balances    | read              | umi-rpc                                           | public    |
| get-transaction       | read              | umi-rpc                                           | public    |
| get-token-price       | read              | umi-rpc, jupiter                                  | public    |
| get-token-metadata    | read              | umi-rpc                                           | public    |
| sleep                 | utility           | (none)                                            | public    |
| fund-agent-sol        | treasury          | umi-rpc, agent-keypair, agent-identity            | public    |
| register-agent        | registration      | umi-rpc, agent-keypair, registry, banner          | owner     |
| delegate-execution    | registration      | umi-rpc, agent-keypair, agent-identity, registry  | owner     |
| launch-token          | registration      | umi-rpc, agent-keypair, agent-identity, genesis, state-store, banner | owner |
| swap-token            | trade             | umi-rpc, agent-keypair, jupiter                   | owner     |
| buyback-token         | trade             | umi-rpc, agent-keypair, agent-token, jupiter      | owner     |
| sell-token            | trade             | umi-rpc, agent-keypair, agent-token, jupiter      | owner     |
| transfer-sol          | transfer          | umi-rpc                                           | public    |
| transfer-token        | transfer          | umi-rpc                                           | public    |
| set-goal              | autonomous-only   | state-store                                       | owner     |
| close-goal            | autonomous-only   | state-store                                       | owner     |
| add-task              | autonomous-only   | state-store                                       | owner     |
| close-task            | autonomous-only   | state-store                                       | owner     |
| set-paused            | autonomous-only   | state-store                                       | owner     |
| withdraw-sol          | treasury          | umi-rpc, agent-keypair                            | owner     |

4. Create `packages/tools/src/tools/index.ts` re-exporting every tool's named export.
5. `pnpm --filter @metaplex-foundation/agent-tools build`.
6. Expected: clean tsc build.

Commit per ~3 tool files so each commit is reviewable. End with: `feat(tools): port all tool definitions to defineTool API`.

### Task 10: Implement `createToolset` builder

**File:** `packages/tools/src/toolset.ts`

```ts
import { withAuth, defaultAuthPolicy, type AuthPolicy } from '@metaplex-foundation/agent-runtime';
import type { Capability, ToolCategory } from './capabilities.js';
import { ALL_CAPABILITIES } from './capabilities.js';
import { listRegisteredTools } from './registry.js';
import type { ToolDefinition } from './define-tool.js';

export interface CreateToolsetOptions {
  include?: ToolSelector[];   // default: all
  exclude?: ToolSelector[];   // default: none
  authPolicy?: AuthPolicy;
  capabilities?: Capability[];  // default: ALL_CAPABILITIES
}

export type ToolSelector = string;   // tool id, '*', or 'category:<name>'

export function createToolset(opts: CreateToolsetOptions = {}): Record<string, any> {
  const policy = opts.authPolicy ?? defaultAuthPolicy;
  const caps = new Set(opts.capabilities ?? ALL_CAPABILITIES);
  const all = listRegisteredTools();
  const allIds = new Set(all.map(t => t.id));
  const allCats = new Set(all.map(t => t.category));

  function resolve(selectors: ToolSelector[]): Set<string> {
    const out = new Set<string>();
    for (const s of selectors) {
      if (s === '*') { all.forEach(t => out.add(t.id)); continue; }
      if (s.startsWith('category:')) {
        const cat = s.slice('category:'.length) as ToolCategory;
        if (!allCats.has(cat)) {
          throw new Error(`Unknown category: ${cat}`);
        }
        for (const t of all) if (t.category === cat) out.add(t.id);
        continue;
      }
      if (!allIds.has(s)) {
        throw new Error(
          `Unknown tool id: ${s}. Known ids: ${Array.from(allIds).sort().join(', ')}`,
        );
      }
      out.add(s);
    }
    return out;
  }

  const included = opts.include ? resolve(opts.include) : new Set(allIds);
  const excluded = opts.exclude ? resolve(opts.exclude) : new Set<string>();
  const finalIds = new Set([...included].filter(id => !excluded.has(id)));

  const result: Record<string, any> = {};
  const missingCaps: Record<string, Capability[]> = {};

  for (const def of all) {
    if (!finalIds.has(def.id)) continue;
    const missing = def.requires.filter(c => !caps.has(c));
    if (missing.length > 0) {
      missingCaps[def.id] = missing;
      continue;
    }
    const wrapped = withAuth(def.tool, def.authLevel, policy);
    // Use camelCase key matching today's export names. Tool ids are
    // kebab-case ('get-balance'); convert to camelCase ('getBalance').
    const key = toCamel(def.id);
    result[key] = wrapped;
  }

  if (Object.keys(missingCaps).length > 0) {
    const lines = Object.entries(missingCaps).map(
      ([id, ms]) => `  ${id}: missing ${ms.join(', ')}`,
    );
    throw new Error(
      `createToolset: tools require capabilities not present in this host:\n${lines.join('\n')}`,
    );
  }

  return result;
}

function toCamel(kebab: string): string {
  return kebab.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
```

Commit: `feat(tools): createToolset builder with capability + auth wiring`.

### Task 11: Add named bundles

**File:** `packages/tools/src/bundles.ts`

```ts
import { createToolset } from './toolset.js';

export const readOnlyBundle      = createToolset({ include: ['category:read'] });
export const tradingBundle       = createToolset({ include: ['category:trade'] });
export const registrationBundle  = createToolset({ include: ['category:registration'] });
export const transferBundle      = createToolset({ include: ['category:transfer'] });
export const treasuryBundle      = createToolset({ include: ['category:treasury'] });

// Convenience: replicate today's two grab-bag exports
export const publicBundle = createToolset({
  exclude: ['category:autonomous-only', 'withdraw-sol'],
});
export const autonomousBundle = createToolset({
  exclude: ['category:transfer'],
});
```

**Important:** bundles call `createToolset` at module load — therefore the
tool files must be imported (i.e., evaluated) BEFORE bundles.ts. Add this
import at the top of `bundles.ts`:
```ts
import './tools/index.js';   // side-effect: registers all tools
```

Commit: `feat(tools): pre-built bundles`.

### Task 12: Write the public `index.ts`

**File:** `packages/tools/src/index.ts`

```ts
import './tools/index.js';   // side-effect: register all tools

export { defineTool, type ToolDefinition } from './define-tool.js';
export type { Capability, ToolCategory } from './capabilities.js';
export { ALL_CAPABILITIES } from './capabilities.js';
export { createToolset, type CreateToolsetOptions, type ToolSelector } from './toolset.js';
export {
  readOnlyBundle, tradingBundle, registrationBundle,
  transferBundle, treasuryBundle, publicBundle, autonomousBundle,
} from './bundles.js';
export { listRegisteredTools, getRegisteredTool } from './registry.js';

// Re-export each individual tool too — for advanced consumers who want
// to build their own toolset manually.
export * from './tools/index.js';
```

`pnpm --filter @metaplex-foundation/agent-tools build`. Expected: clean.

Commit: `feat(tools): public index exports`.

### Task 13: Port tool unit + integration tests

**Files:** copy from `014-agent-template/packages/core/test/{unit,integration}/tools/` to `metaplex-agent-toolkit/packages/tools/test/{unit,integration}/`.

Rewrites:
- Imports of `@metaplex-foundation/shared` → `@metaplex-foundation/agent-runtime`.
- Imports of `../src/tools/shared/X.js` etc. → `../src/tools/X.js`.
- Test helpers reused — copy from `packages/core/test/helpers/` into `packages/tools/test/helpers/`.

Run: `pnpm --filter @metaplex-foundation/agent-tools test`.
Expected: same green output the template gives today for these tests.

Fix any test that asserts the old import surface. Tests asserting the
wrapped (`withAuth`) behavior need to either:
- Build via `createToolset({ include: ['<id>'] })` and pull from result, or
- Call `withAuth(def.tool, def.authLevel)` themselves.

Commit: `test(tools): port tool tests`.

### Task 14: Add toolset / bundle / capability unit tests (NEW)

**File:** `packages/tools/test/unit/toolset.test.ts`

Cover:
- `createToolset({})` returns every tool, all wrapped with auth.
- `include: ['get-balance']` returns just `getBalance`.
- `include: ['category:read']` returns all read-category tools, no others.
- `exclude: ['withdraw-sol']` removes only that tool.
- Unknown id → throws with the full id list in the message.
- Unknown category → throws with the category name.
- `capabilities: ['umi-rpc']` with a tool requiring `jupiter` → throws naming `jupiter`.
- Custom `authPolicy` is invoked at execute time.
- Bundle exports (`readOnlyBundle`, `publicBundle`, `autonomousBundle`) contain expected tools and exclude expected ones.

Run: `pnpm --filter @metaplex-foundation/agent-tools test`.

Commit: `test(tools): toolset builder + bundle coverage`.

---

## Pass 2 — Migrate `014-agent-template`

### Task 15: Link the toolkit into the template via pnpm `link:`

**Files:**
- Modify: `014-agent-template/packages/core/package.json` (deps)
- Modify: `014-agent-template/packages/shared/package.json` (deps)
- Modify: `014-agent-template/pnpm-workspace.yaml` (optional: include sibling)

**Steps:**
1. Add to `core/package.json` dependencies:
   ```json
   "@metaplex-foundation/agent-tools": "link:../../../metaplex-agent-toolkit/packages/tools",
   "@metaplex-foundation/agent-runtime": "link:../../../metaplex-agent-toolkit/packages/runtime"
   ```
2. Add to `shared/package.json` dependencies:
   ```json
   "@metaplex-foundation/agent-runtime": "link:../../../metaplex-agent-toolkit/packages/runtime"
   ```
3. `pnpm install` at template root.
4. Expected: lockfile updates, links resolve.

Commit: `chore: link metaplex-agent-toolkit packages`.

### Task 16: Rewire `packages/shared` to re-export runtime

**File:** `014-agent-template/packages/shared/src/index.ts`

Replace the runtime exports with re-exports from runtime:
```ts
export * from '@metaplex-foundation/agent-runtime';
// keep the transport-only exports
export * from './siws.js';
export * from './nonce-store.js';
export * from './allowlist.js';
export * from './allowlist-file.js';
export * from './wallet-rate-limit.js';
export * from './server-limits.js';
export * from './types/protocol.js';
```

Delete the source files now provided by runtime:
- `config.ts`, `state.ts`, `umi.ts`, `auth.ts`, `jupiter.ts`, `transaction.ts`,
  `funding.ts`, `execute.ts`, `error-codes.ts`, `registration-banner.ts`,
  `paas.ts`, `agent-config.ts`, `context.ts`
- `types/agent.ts`, `types/tool-result.ts`

`pnpm --filter @metaplex-foundation/shared build`.
Expected: clean (everything still exported by the same names, just from runtime).

`pnpm --filter @metaplex-foundation/shared test`.
Expected: tests still pass (they import from `@metaplex-foundation/shared` which re-exports).

Commit: `refactor(shared): consume runtime from @metaplex-foundation/agent-runtime`.

### Task 17: Rewire `packages/core` to consume toolkit bundles

**Files:**
- Modify: `014-agent-template/packages/core/src/agent-public.ts`
- Modify: `014-agent-template/packages/core/src/agent-autonomous.ts`
- Delete: `014-agent-template/packages/core/src/tools/` (entire dir)

**agent-public.ts:**
```ts
import { Agent } from '@mastra/core/agent';
import { getConfig } from '@metaplex-foundation/agent-runtime';
import { publicBundle } from '@metaplex-foundation/agent-tools';
// persona + prompt imports unchanged
export function createPublicAgent() {
  // ...same persona/prompt logic...
  return new Agent({
    id: 'metaplex-agent-public',
    name: config.ASSISTANT_NAME,
    instructions: buildSystemPrompt('public', normalizedPersona),
    model: config.LLM_MODEL,
    tools: publicBundle,
  });
}
```

**agent-autonomous.ts:** same shape, `autonomousBundle`.

Delete `packages/core/src/tools/` and its `test/integration/tools/` mirror —
the tool tests now live in the toolkit.

`pnpm --filter @metaplex-foundation/core build`.
Expected: clean.

`pnpm --filter @metaplex-foundation/core test` — expected: passes (only persona + prompt tests remain).

Commit: `refactor(core): consume toolkit bundles for agent assembly`.

### Task 18: Full repo verification

**Steps:**
1. `pnpm install` at template root.
2. `pnpm build`.
3. `pnpm typecheck`.
4. `pnpm test`.

Expected: all green. Address any breakage immediately (do not skip).

Commit: `test: verify end-to-end after toolkit migration` (if any test files needed adjustment).

### Task 19: Update docs

**Files:**
- Modify: `014-agent-template/docs/ARCHITECTURE.md` — point the "tool authoring" section at `@metaplex-foundation/agent-tools`.
- Modify: `014-agent-template/README.md` — add a one-liner under "What you can build" about the toolkit.
- Create: `metaplex-agent-toolkit/README.md` — quick-start: install, defineTool example, createToolset example, bundle list.

Commit: `docs: document toolkit + update template references`.

---

## Test plan (when finished)

- `pnpm --filter @metaplex-foundation/agent-runtime test` — runtime unit + integration green.
- `pnpm --filter @metaplex-foundation/agent-tools test` — tools + toolset green.
- `pnpm test` in `014-agent-template` — full suite green, including E2E.
- `pnpm dev` in `014-agent-template` boots, accepts a websocket connection, runs a tool call (smoke).
