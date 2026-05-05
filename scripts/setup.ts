#!/usr/bin/env tsx
/**
 * pnpm setup — interactive scaffolder for a fresh checkout.
 *
 * Replaces the manual "copy .env.example, generate keypair, paste pubkey"
 * dance with a one-shot prompt:
 *
 *   - Picks AGENT_MODE (public / autonomous)
 *   - Generates AGENT_KEYPAIR (Ed25519, base58-encoded) so the operator
 *     doesn't need solana-keygen installed
 *   - Prompts for an LLM key (Anthropic by default)
 *   - Prompts for the operator's wallet pubkey → seeds WALLET_ALLOWLIST
 *     and (optionally) wallets.allowlist.json
 *   - Writes .env atomically (refuses to overwrite without --force)
 *
 * v0 limitation: this scaffolds an EXISTING checkout. A future iteration
 * may publish as `npx create-metaplex-agent` and copy the template into a
 * new directory.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const FORCE = process.argv.includes('--force');

const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---- helpers ----

const rl = createInterface({ input, output });

async function ask(q: string, fallback = ''): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = (await rl.question(`${q}${suffix}: `)).trim();
  return answer || fallback;
}

async function askYesNo(q: string, defaultYes = true): Promise<boolean> {
  const fallback = defaultYes ? 'Y/n' : 'y/N';
  const answer = (await rl.question(`${q} [${fallback}]: `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

function generateKeypairBase58(): string {
  // tweetnacl returns a 64-byte secret key (seed || pubkey). That's the
  // format AGENT_KEYPAIR expects when supplied as base58.
  const kp = nacl.sign.keyPair();
  return bs58.encode(kp.secretKey);
}

function pubkeyFromKeypair(secretKeyBase58: string): string {
  const decoded = bs58.decode(secretKeyBase58);
  const pubkey = decoded.slice(32, 64);
  return bs58.encode(pubkey);
}

function isValidPubkey(s: string): boolean {
  if (!BASE58_ADDRESS_RE.test(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

// ---- main ----

async function main(): Promise<void> {
  console.log('\nMetaplex Agent Template — interactive setup\n');

  const envPath = resolve(ROOT, '.env');
  if (existsSync(envPath) && !FORCE) {
    const overwrite = await askYesNo(
      `.env already exists at ${envPath} — overwrite?`,
      false,
    );
    if (!overwrite) {
      console.log('Aborted. Use --force to overwrite without prompting.');
      rl.close();
      return;
    }
  }

  // 1. Mode
  console.log('\n1. Agent mode\n');
  console.log('  public     — end users sign their own transactions (chatbot, mint helper, etc.)');
  console.log('  autonomous — agent signs everything itself (treasury bot, scheduled job, etc.)\n');
  const modeRaw = await ask('AGENT_MODE', 'public');
  const mode = modeRaw === 'autonomous' ? 'autonomous' : 'public';

  // 2. Keypair
  console.log('\n2. Agent keypair\n');
  console.log('  This is the agent\'s on-chain identity. The setup script will generate a fresh');
  console.log('  Ed25519 keypair so you don\'t need solana-keygen installed. Treat the generated');
  console.log('  secret key like a password — anyone with it can sign as the agent.\n');
  const generate = await askYesNo('Generate a new keypair?', true);
  let agentKeypair: string;
  let agentPubkey: string;
  if (generate) {
    agentKeypair = generateKeypairBase58();
    agentPubkey = pubkeyFromKeypair(agentKeypair);
    console.log(`  → generated; pubkey: ${agentPubkey}`);
  } else {
    while (true) {
      agentKeypair = (await ask('Paste base58 64-byte secret key')).trim();
      try {
        const decoded = bs58.decode(agentKeypair);
        if (decoded.length !== 64) {
          console.log(`  Expected 64 bytes, got ${decoded.length}. Try again.`);
          continue;
        }
        agentPubkey = pubkeyFromKeypair(agentKeypair);
        break;
      } catch {
        console.log('  Not valid base58. Try again.');
      }
    }
  }

  // 3. LLM provider + key
  console.log('\n3. LLM provider\n');
  console.log('  1) Anthropic (default)');
  console.log('  2) OpenAI');
  console.log('  3) Google\n');
  const choice = await ask('Pick provider [1-3]', '1');
  const providerKey = choice === '2'
    ? 'OPENAI_API_KEY'
    : choice === '3'
      ? 'GOOGLE_GENERATIVE_AI_API_KEY'
      : 'ANTHROPIC_API_KEY';
  const llmModel = providerKey === 'OPENAI_API_KEY'
    ? 'openai/gpt-4o'
    : providerKey === 'GOOGLE_GENERATIVE_AI_API_KEY'
      ? 'google/gemini-2.5-pro'
      : 'anthropic/claude-sonnet-4-5-20250929';
  const llmKey = (await ask(`Paste ${providerKey} (leave blank to fill later)`)).trim();

  // 4. Wallet allowlist (public mode)
  let walletAllowlist = '';
  let bootstrapWallet = '';
  if (mode === 'public') {
    console.log('\n4. Wallet allowlist (optional)\n');
    console.log('  In public mode the agent accepts SIWS-signed connections from any wallet by');
    console.log('  default. To restrict it to a specific list (e.g. just your own wallet for the');
    console.log('  initial test), paste your wallet pubkey below. The on-chain owner is always');
    console.log('  allowed regardless of this list.\n');
    while (true) {
      const pk = (await ask('Your wallet pubkey (or blank to skip)')).trim();
      if (pk === '') break;
      if (!isValidPubkey(pk)) {
        console.log('  Not a valid base58 32-byte pubkey. Try again or leave blank.');
        continue;
      }
      walletAllowlist = pk;
      break;
    }
  } else {
    console.log('\n4. Bootstrap wallet (autonomous mode)\n');
    console.log('  Autonomous mode requires a BOOTSTRAP_WALLET pubkey before the agent is');
    console.log('  registered on-chain. After registration, the on-chain asset owner takes over.\n');
    while (true) {
      const pk = (await ask('BOOTSTRAP_WALLET pubkey (your wallet)')).trim();
      if (!isValidPubkey(pk)) {
        console.log('  Not a valid base58 32-byte pubkey. Try again.');
        continue;
      }
      bootstrapWallet = pk;
      break;
    }
  }

  rl.close();

  // 5. Render .env
  const examplePath = resolve(ROOT, '.env.example');
  let envContent = existsSync(examplePath) ? readFileSync(examplePath, 'utf8') : '';
  envContent = envContent
    .replace(/^AGENT_MODE=.*$/m, `AGENT_MODE=${mode}`)
    .replace(/^AGENT_KEYPAIR=.*$/m, `AGENT_KEYPAIR=${agentKeypair}`)
    .replace(/^ANTHROPIC_API_KEY=.*$/m, `${providerKey === 'ANTHROPIC_API_KEY' ? '' : '# '}ANTHROPIC_API_KEY=${providerKey === 'ANTHROPIC_API_KEY' ? llmKey : ''}`)
    .replace(/^# OPENAI_API_KEY=.*$/m, `${providerKey === 'OPENAI_API_KEY' ? '' : '# '}OPENAI_API_KEY=${providerKey === 'OPENAI_API_KEY' ? llmKey : ''}`)
    .replace(/^# GOOGLE_GENERATIVE_AI_API_KEY=.*$/m, `${providerKey === 'GOOGLE_GENERATIVE_AI_API_KEY' ? '' : '# '}GOOGLE_GENERATIVE_AI_API_KEY=${providerKey === 'GOOGLE_GENERATIVE_AI_API_KEY' ? llmKey : ''}`)
    .replace(/^WALLET_ALLOWLIST=.*$/m, `WALLET_ALLOWLIST=${walletAllowlist}`)
    .replace(/^# BOOTSTRAP_WALLET=.*$/m, bootstrapWallet ? `BOOTSTRAP_WALLET=${bootstrapWallet}` : '# BOOTSTRAP_WALLET=');

  // If the LLM_MODEL line isn't present in the slim example (it's a default),
  // write the chosen model when the user picked something other than Anthropic.
  if (llmModel !== 'anthropic/claude-sonnet-4-5-20250929' && !envContent.match(/^LLM_MODEL=/m)) {
    envContent = envContent.replace(
      /^# LLM\. One key required.*$/m,
      `# LLM. One key required.\nLLM_MODEL=${llmModel}`,
    );
  }

  writeFileSync(envPath, envContent, { mode: 0o600 });
  console.log(`\n  wrote ${envPath} (chmod 0600)`);

  // 6. wallets.allowlist.json
  if (mode === 'public' && walletAllowlist) {
    const allowlistPath = resolve(ROOT, 'wallets.allowlist.json');
    const seedAllowlist = !existsSync(allowlistPath) || await new Promise<boolean>((res) => res(true));
    if (seedAllowlist) {
      writeFileSync(
        allowlistPath,
        JSON.stringify({ wallets: [walletAllowlist] }, null, 2) + '\n',
      );
      console.log(`  wrote ${allowlistPath}`);
    }
  }

  console.log('\nDone. Next steps:\n');
  console.log('  1. Run `pnpm doctor` to validate the setup');
  console.log('  2. Run `pnpm dev:full` to start the server + chat UI');
  console.log(`  3. Connect a wallet at http://localhost:3001 (${mode === 'public' ? 'must be on the allowlist' : 'must be the bootstrap wallet pre-registration'})`);
  console.log();
}

main().catch((err) => {
  console.error('[setup] error:', err);
  process.exit(1);
});
