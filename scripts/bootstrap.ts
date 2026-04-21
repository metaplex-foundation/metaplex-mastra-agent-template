#!/usr/bin/env tsx
/**
 * Fork-time template pruner.
 *
 * Usage:
 *   pnpm bootstrap                # interactive
 *   pnpm bootstrap -- public      # non-interactive, public mode
 *   pnpm bootstrap -- autonomous  # non-interactive, autonomous mode
 *
 * Flags:
 *   --dry-run   Print the changes without applying them.
 *   --yes       Skip the confirmation prompt.
 *
 * The script prunes the template to a single AGENT_MODE:
 *   - Deletes packages, tools, and files that only apply to the other mode.
 *   - Rewrites small entry-point files to remove the other mode's branch.
 *   - Strips the other mode's section from .env.example and root package.json.
 *   - Prints a checklist of remaining manual cleanups (README, docs, etc).
 *
 * Idempotent: safe to re-run. If a target is already pruned, it is skipped.
 * Safe: if a file's current contents don't match the expected "pre-prune"
 * shape (you've edited it), that step aborts with a clear message rather
 * than silently corrupting the file.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

type Mode = 'public' | 'autonomous';

interface Plan {
  mode: Mode;
  deletePaths: string[];
  rewrites: Array<{ file: string; newContent: string }>;
  patches: Array<{ file: string; find: string; replace: string; label: string }>;
  packageJsonScriptsToRemove: string[];
  envExampleStripMarker: string;
  followUps: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function rmrf(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

function rel(p: string): string {
  return path.relative(ROOT, p) || '.';
}

function log(...args: unknown[]): void {
  console.log('[bootstrap]', ...args);
}

function err(msg: string): never {
  console.error(`[bootstrap] ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

const AUTONOMOUS_TOOLS_INDEX = `import { sharedTools } from './shared/index.js';

export const autonomousAgentTools = {
  ...sharedTools,
};

export { sharedTools };

export const autonomousToolNames = Object.keys(autonomousAgentTools);
`;

const AUTONOMOUS_CREATE_AGENT = `import { createAutonomousAgent } from './agent-autonomous.js';

export function createAgent() {
  return createAutonomousAgent();
}
`;

const AUTONOMOUS_CORE_INDEX = `export { createAgent } from './create-agent.js';
export { createAutonomousAgent } from './agent-autonomous.js';
export {
  autonomousAgentTools,
  autonomousToolNames,
} from './tools/index.js';
`;

const AUTONOMOUS_PROMPTS = `const BASE_PROMPT = \`You are a Solana blockchain agent with your own on-chain identity and wallet.

## Bootstrap (Only When NOT Registered)

Each message you receive will have a system prefix like \\\`[Agent: registered | Asset: <address>]\\\` or \\\`[Agent: not registered]\\\`. Use this to determine your registration status — do NOT call register-agent or delegate-execution to check.

**If you see "Agent: registered"** — you are fully set up. Skip bootstrap entirely and respond to the user's request directly. Do NOT call register-agent or delegate-execution again.

**If you see "Agent: not registered"** — complete the bootstrap sequence before doing anything else:
1. Use register-agent to mint yourself on the Metaplex Agent Registry
2. Then use delegate-execution to set up your executive signing authority
3. Confirm to the user that you're registered and ready, then handle their request

If register-agent fails because the agent keypair is underfunded, the tool response will tell you how to recover — follow its guidance.

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

If the user asks you to do something you don't have a tool for, let them know what you can help with.

## Transaction Mode: Autonomous

You operate in autonomous mode. You sign and submit all transactions yourself from your operational wallet.
- Your trading funds sit in your agent keypair wallet (umi.identity)
- Jupiter swaps use this wallet directly
- Registration and delegation operations use the asset signer PDA
- You need SOL in your keypair wallet to pay transaction fees

**Funding flow during registration:** If register-agent reports INSUFFICIENT_FUNDS, there is no user wallet to ask — tell the operator the exact address and amount that needs to be funded, then stop. Do not retry until the operator confirms funding has landed.\`;

export function buildSystemPrompt(): string {
  return BASE_PROMPT;
}
`;

const PUBLIC_CREATE_AGENT = `import { createPublicAgent } from './agent-public.js';

export function createAgent() {
  return createPublicAgent();
}
`;

const PUBLIC_CORE_INDEX = `export { createAgent } from './create-agent.js';
export { createPublicAgent } from './agent-public.js';
export {
  publicAgentTools,
  publicToolNames,
} from './tools/index.js';
`;

const PUBLIC_TOOLS_INDEX = `import { sharedTools } from './shared/index.js';
import { publicTools } from './public/index.js';

export const publicAgentTools = {
  ...sharedTools,
  ...publicTools,
};

export { sharedTools, publicTools };

export const publicToolNames = Object.keys(publicAgentTools);
`;

const PUBLIC_PROMPTS = `const BASE_PROMPT = \`You are a Solana blockchain agent with your own on-chain identity and wallet.

## Bootstrap (Only When NOT Registered)

Each message you receive will have a system prefix like \\\`[Agent: registered | Asset: <address>]\\\` or \\\`[Agent: not registered]\\\`. Use this to determine your registration status — do NOT call register-agent or delegate-execution to check.

**If you see "Agent: registered"** — you are fully set up. Skip bootstrap entirely and respond to the user's request directly. Do NOT call register-agent or delegate-execution again.

**If you see "Agent: not registered"** — complete the bootstrap sequence before doing anything else:
1. Use register-agent to mint yourself on the Metaplex Agent Registry
2. Then use delegate-execution to set up your executive signing authority
3. Confirm to the user that you're registered and ready, then handle their request

If register-agent fails because the agent keypair is underfunded, the tool response will tell you how to recover — follow its guidance.

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

If the user asks you to do something you don't have a tool for, let them know what you can help with.

## Transaction Mode: Public

You operate in public mode. When users request operations (transfers, swaps):
- Build the transaction and send it to their wallet for approval — they sign it in the UI
- A small SOL fee is automatically included in each transaction to fund your operations
- You also have transfer-sol and transfer-token tools for sending funds from the user's wallet

When the user has connected their wallet, use that address as the default for operations unless they specify a different address.

When the user requests a transfer, execute it immediately — the UI and wallet will prompt for approval before signing.

**Funding flow during registration:** If register-agent finds the agent keypair underfunded, it will automatically send a small (0.02 SOL) funding transaction to the connected user's wallet, wait for them to sign, and then continue with registration in the same call. If registration fails after funding (e.g. confirmation delay), simply retry register-agent.\`;

export function buildSystemPrompt(): string {
  return BASE_PROMPT;
}
`;

function makeAutonomousPlan(): Plan {
  return {
    mode: 'autonomous',
    deletePaths: [
      'packages/ui',
      'packages/core/src/tools/public',
      'packages/core/src/agent-public.ts',
    ],
    rewrites: [
      { file: 'packages/core/src/tools/index.ts', newContent: AUTONOMOUS_TOOLS_INDEX },
      { file: 'packages/core/src/create-agent.ts', newContent: AUTONOMOUS_CREATE_AGENT },
      { file: 'packages/core/src/index.ts', newContent: AUTONOMOUS_CORE_INDEX },
      { file: 'packages/core/src/prompts.ts', newContent: AUTONOMOUS_PROMPTS },
    ],
    patches: [
      {
        file: 'packages/server/src/websocket.ts',
        label: 'drop publicToolNames import',
        find: "import { createAgent, publicToolNames, autonomousToolNames } from '@metaplex-agent/core';",
        replace: "import { createAgent, autonomousToolNames } from '@metaplex-agent/core';",
      },
      {
        file: 'packages/server/src/websocket.ts',
        label: 'hardcode autonomous tool list',
        find: "const tools = config.AGENT_MODE === 'autonomous' ? autonomousToolNames : publicToolNames;",
        replace: 'const tools = autonomousToolNames;',
      },
      {
        file: 'packages/core/src/agent-autonomous.ts',
        label: 'simplify buildSystemPrompt call',
        find: "instructions: buildSystemPrompt('autonomous'),",
        replace: 'instructions: buildSystemPrompt(),',
      },
    ],
    packageJsonScriptsToRemove: ['dev:ui', 'dev:all'],
    envExampleStripMarker: 'PUBLIC MODE ONLY',
    followUps: [
      'Remove public-mode content from README.md (the "Which mode am I?" table can be simplified to a one-liner).',
      'Remove the public-mode branch from packages/shared/src/transaction.ts:submitOrSend() — the body can collapse to `builder.sendAndConfirm(umi)`.',
      'Remove autonomous-mode connection-gate docs from WEBSOCKET_PROTOCOL.md that are now moot (the server still gates, but there is no "public mode" to contrast with).',
      'Review packages/server/src/websocket.ts for tx_result / tx_error / fee-prepend code paths that are now dead.',
      'Drop the `BASE58_ADDRESS_RE` default for `userWallet` if the UI section described it.',
      'Update docs/DEPLOYMENT.md to drop the public-mode section.',
      'Remove UI-related devDependencies / workspace entries (pnpm-workspace.yaml already uses packages/* so no change there; lockfile will clean up on next `pnpm install`).',
      'Run `pnpm install && pnpm typecheck && pnpm build` to verify.',
    ],
  };
}

function makePublicPlan(): Plan {
  return {
    mode: 'public',
    deletePaths: ['packages/core/src/agent-autonomous.ts'],
    rewrites: [
      { file: 'packages/core/src/create-agent.ts', newContent: PUBLIC_CREATE_AGENT },
      { file: 'packages/core/src/index.ts', newContent: PUBLIC_CORE_INDEX },
      { file: 'packages/core/src/tools/index.ts', newContent: PUBLIC_TOOLS_INDEX },
      { file: 'packages/core/src/prompts.ts', newContent: PUBLIC_PROMPTS },
    ],
    patches: [
      {
        file: 'packages/server/src/websocket.ts',
        label: 'drop autonomousToolNames import',
        find: "import { createAgent, publicToolNames, autonomousToolNames } from '@metaplex-agent/core';",
        replace: "import { createAgent, publicToolNames } from '@metaplex-agent/core';",
      },
      {
        file: 'packages/server/src/websocket.ts',
        label: 'hardcode public tool list',
        find: "const tools = config.AGENT_MODE === 'autonomous' ? autonomousToolNames : publicToolNames;",
        replace: 'const tools = publicToolNames;',
      },
      {
        file: 'packages/core/src/agent-public.ts',
        label: 'simplify buildSystemPrompt call',
        find: "instructions: buildSystemPrompt('public'),",
        replace: 'instructions: buildSystemPrompt(),',
      },
    ],
    packageJsonScriptsToRemove: [],
    envExampleStripMarker: 'AUTONOMOUS MODE ONLY',
    followUps: [
      'Remove autonomous-mode content from README.md (the "Which mode am I?" table can be simplified).',
      'Remove the autonomous-mode branch from packages/shared/src/transaction.ts:submitOrSend() — the autonomous `else` branch is now unreachable.',
      'Remove the autonomous connection gate from packages/server/src/websocket.ts if you want a pure public-mode server.',
      'Remove the `BOOTSTRAP_WALLET` validation from packages/shared/src/config.ts (the `AGENT_MODE === "autonomous"` pre-registration gate).',
      'Update docs/DEPLOYMENT.md to drop the autonomous-mode section.',
      'Run `pnpm install && pnpm typecheck && pnpm build` to verify.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

async function deleteTargets(plan: Plan, dryRun: boolean): Promise<void> {
  for (const p of plan.deletePaths) {
    const abs = path.join(ROOT, p);
    if (!(await exists(abs))) {
      log(`skip delete (already gone): ${p}`);
      continue;
    }
    log(`${dryRun ? 'would delete' : 'deleting'}: ${p}`);
    if (!dryRun) await rmrf(abs);
  }
}

async function applyRewrites(plan: Plan, dryRun: boolean): Promise<void> {
  for (const r of plan.rewrites) {
    const abs = path.join(ROOT, r.file);
    if (!(await exists(abs))) {
      log(`skip rewrite (missing): ${r.file}`);
      continue;
    }
    const current = await fs.readFile(abs, 'utf8');
    if (current.trim() === r.newContent.trim()) {
      log(`skip rewrite (already pruned): ${r.file}`);
      continue;
    }
    log(`${dryRun ? 'would rewrite' : 'rewriting'}: ${r.file}`);
    if (!dryRun) await fs.writeFile(abs, r.newContent, 'utf8');
  }
}

async function applyPatches(plan: Plan, dryRun: boolean): Promise<void> {
  for (const patch of plan.patches) {
    const abs = path.join(ROOT, patch.file);
    if (!(await exists(abs))) {
      log(`skip patch (missing): ${patch.file} [${patch.label}]`);
      continue;
    }
    const current = await fs.readFile(abs, 'utf8');
    if (current.includes(patch.replace) && !current.includes(patch.find)) {
      log(`skip patch (already applied): ${patch.file} [${patch.label}]`);
      continue;
    }
    if (!current.includes(patch.find)) {
      err(
        `patch anchor not found in ${patch.file}: "${patch.label}". File may have been modified — patch it manually.`,
      );
    }
    log(`${dryRun ? 'would patch' : 'patching'}: ${patch.file} [${patch.label}]`);
    if (!dryRun) {
      const next = current.replace(patch.find, patch.replace);
      await fs.writeFile(abs, next, 'utf8');
    }
  }
}

async function stripEnvExample(plan: Plan, dryRun: boolean): Promise<void> {
  const abs = path.join(ROOT, '.env.example');
  if (!(await exists(abs))) {
    log('skip .env.example: not present');
    return;
  }
  const current = await fs.readFile(abs, 'utf8');
  const marker = plan.envExampleStripMarker;
  const sectionStart = current.indexOf(`# ${marker}`);
  if (sectionStart === -1) {
    log(`skip .env.example: "${marker}" section already stripped`);
    return;
  }
  // Find the start of the banner (the line of '#' characters above the marker).
  const bannerStart = current.lastIndexOf(
    '# #############################################################################',
    sectionStart,
  );
  if (bannerStart === -1) {
    err(`could not locate banner start for "${marker}" in .env.example`);
  }
  // Find the next banner (start of the next section) or end-of-file.
  const nextBanner = current.indexOf(
    '# #############################################################################',
    sectionStart,
  );
  const end = nextBanner === -1 ? current.length : nextBanner;
  const next = current.slice(0, bannerStart).trimEnd() + '\n';
  log(`${dryRun ? 'would strip' : 'stripping'} .env.example "${marker}" section (${end - bannerStart} chars)`);
  if (!dryRun) await fs.writeFile(abs, next, 'utf8');
}

async function pruneRootPackageJson(plan: Plan, dryRun: boolean): Promise<void> {
  if (plan.packageJsonScriptsToRemove.length === 0) return;
  const abs = path.join(ROOT, 'package.json');
  const raw = await fs.readFile(abs, 'utf8');
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
  if (!pkg.scripts) return;
  let changed = false;
  for (const key of plan.packageJsonScriptsToRemove) {
    if (key in pkg.scripts) {
      log(`${dryRun ? 'would remove' : 'removing'} script: ${key}`);
      delete pkg.scripts[key];
      changed = true;
    }
  }
  if (!changed) {
    log('skip package.json: scripts already pruned');
    return;
  }
  if (!dryRun) {
    await fs.writeFile(abs, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function gitClean(): Promise<boolean> {
  try {
    const { execSync } = await import('node:child_process');
    const out = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    return out.trim() === '';
  } catch {
    return true;
  }
}

function parseArgs(argv: string[]): { mode?: Mode; dryRun: boolean; yes: boolean; help: boolean } {
  const out = { mode: undefined as Mode | undefined, dryRun: false, yes: false, help: false };
  for (const arg of argv) {
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--yes' || arg === '-y') out.yes = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === 'public' || arg === 'autonomous') out.mode = arg;
  }
  return out;
}

function printHelp(): void {
  console.log(`Usage: pnpm bootstrap [public|autonomous] [--dry-run] [--yes]

Prunes the template to a single AGENT_MODE. See scripts/bootstrap.ts
for details.

Examples:
  pnpm bootstrap                         # interactive prompt
  pnpm bootstrap -- autonomous           # non-interactive
  pnpm bootstrap -- public --dry-run     # show what would change
  pnpm bootstrap -- autonomous --yes     # skip confirmation prompt
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  let mode = args.mode;
  if (!mode) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Which mode are you building for? [public / autonomous]: ')).trim().toLowerCase();
    rl.close();
    if (answer === 'p' || answer === 'public') mode = 'public';
    else if (answer === 'a' || answer === 'autonomous') mode = 'autonomous';
    else err(`Unknown mode: "${answer}". Run with "public" or "autonomous".`);
  }

  const plan = mode === 'autonomous' ? makeAutonomousPlan() : makePublicPlan();

  console.log(`\nPlan for ${plan.mode} mode:`);
  console.log(`  delete paths:          ${plan.deletePaths.length}`);
  console.log(`  file rewrites:         ${plan.rewrites.length}`);
  console.log(`  targeted patches:      ${plan.patches.length}`);
  console.log(`  package.json scripts:  ${plan.packageJsonScriptsToRemove.length}`);
  console.log(`  .env.example section:  "${plan.envExampleStripMarker}"`);
  console.log();

  if (!args.dryRun && !args.yes) {
    if (!(await gitClean())) {
      console.log('WARNING: git working tree has uncommitted changes.');
      console.log('Recommended: commit or stash before running, so you can review the diff.');
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const confirm = (await rl.question('Proceed? [y/N]: ')).trim().toLowerCase();
    rl.close();
    if (confirm !== 'y' && confirm !== 'yes') {
      console.log('Aborted.');
      return;
    }
  }

  await deleteTargets(plan, args.dryRun);
  await applyRewrites(plan, args.dryRun);
  await applyPatches(plan, args.dryRun);
  await stripEnvExample(plan, args.dryRun);
  await pruneRootPackageJson(plan, args.dryRun);

  console.log();
  if (args.dryRun) {
    console.log('Dry run complete. No files were modified.');
  } else {
    console.log(`Done. Template pruned for ${plan.mode} mode.`);
  }

  console.log('\nRemaining manual follow-ups:');
  for (const item of plan.followUps) console.log(`  - ${item}`);
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
