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

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * Recover the canonical Ed25519 public key from a base58-encoded 64-byte
 * secret key (Solana / NaCl / libsodium expanded format: `seed (32) ||
 * pubkey (32)`).
 *
 * We don't trust the trailing 32 bytes blindly: `nacl.sign.keyPair.fromSecretKey`
 * re-derives the pubkey from the seed and returns the canonical form. We
 * then compare against the bytes the operator pasted — a mismatch means
 * the input is either a different keypair format (e.g. raw seed only,
 * or an unrelated 64-byte blob) or has been tampered with, and we fail
 * fast instead of silently emitting a wrong wallet address.
 */
function pubkeyFromKeypair(secretKeyBase58: string): string {
  const decoded = bs58.decode(secretKeyBase58);
  if (decoded.length !== 64) {
    throw new Error(`expected 64-byte secret key, got ${decoded.length} bytes`);
  }
  const derived = nacl.sign.keyPair.fromSecretKey(decoded);
  const trailing = decoded.slice(32, 64);
  for (let i = 0; i < 32; i++) {
    if (derived.publicKey[i] !== trailing[i]) {
      throw new Error(
        'AGENT_KEYPAIR is not in canonical Ed25519 layout — the trailing 32 bytes ' +
        'do not match the public key derived from the leading 32-byte seed. ' +
        'Re-export from your wallet or regenerate via `pnpm setup`.',
      );
    }
  }
  return bs58.encode(derived.publicKey);
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
  let mode: 'public' | 'autonomous' | null = null;
  while (mode === null) {
    const raw = (await ask('AGENT_MODE', 'public')).toLowerCase();
    if (raw === 'public' || raw === 'autonomous') {
      mode = raw;
    } else {
      console.log(`  "${raw}" is not a valid mode. Pick "public" or "autonomous".`);
    }
  }

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
      // Keep the decode error path separate from pubkeyFromKeypair's so a
      // canonical-layout mismatch (e.g. seed||stale-pubkey blob) surfaces
      // its real reason instead of being collapsed into "Not valid base58".
      let decoded: Uint8Array;
      try {
        decoded = bs58.decode(agentKeypair);
      } catch {
        console.log('  Not valid base58. Try again.');
        continue;
      }
      if (decoded.length !== 64) {
        console.log(`  Expected 64 bytes, got ${decoded.length}. Try again.`);
        continue;
      }
      try {
        agentPubkey = pubkeyFromKeypair(agentKeypair);
        break;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.log(`  ${detail}`);
        // Loop and let the operator paste a different key.
      }
    }
  }

  // 3. LLM provider + key
  console.log('\n3. LLM provider\n');
  console.log('  1) Anthropic (default)');
  console.log('  2) OpenAI');
  console.log('  3) Google\n');
  const PROVIDERS = {
    '1': { key: 'ANTHROPIC_API_KEY' as const, model: 'anthropic/claude-sonnet-4-5-20250929' },
    '2': { key: 'OPENAI_API_KEY' as const, model: 'openai/gpt-4o' },
    '3': { key: 'GOOGLE_GENERATIVE_AI_API_KEY' as const, model: 'google/gemini-2.5-pro' },
  } satisfies Record<string, { key: string; model: string }>;
  let provider: typeof PROVIDERS[keyof typeof PROVIDERS] | null = null;
  while (provider === null) {
    const raw = (await ask('Pick provider [1-3]', '1')).trim();
    if (raw in PROVIDERS) {
      provider = PROVIDERS[raw as keyof typeof PROVIDERS];
    } else {
      console.log(`  "${raw}" is not a valid choice. Enter 1, 2, or 3.`);
    }
  }
  const providerKey = provider.key;
  const llmModel = provider.model;
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

  // 5. Persona preset
  console.log('\n5. Agent persona (system-prompt preset)\n');
  console.log('  Picks the agent\'s domain identity. Bundled options:');
  console.log('    1) default                  — general-purpose Solana agent');
  console.log('    2) token-launch-concierge   — walks users through launching a token');
  console.log('    3) wallet-cleanup-bot       — finds and sweeps dust');
  console.log('    4) treasury-rebalancer      — autonomous treasury management');
  console.log('  See packages/core/src/personas/ for the full prompts.\n');
  const PERSONA_CHOICES: Record<string, string> = {
    '1': 'default',
    '2': 'token-launch-concierge',
    '3': 'wallet-cleanup-bot',
    '4': 'treasury-rebalancer',
  };
  let agentPersona: string = 'default';
  while (true) {
    const raw = (await ask('Pick persona [1-4]', '1')).trim();
    if (raw in PERSONA_CHOICES) {
      agentPersona = PERSONA_CHOICES[raw]!;
      break;
    }
    console.log(`  "${raw}" is not a valid choice. Enter 1-4.`);
  }

  rl.close();

  // 6. Render .env
  const examplePath = resolve(ROOT, '.env.example');
  let envContent = existsSync(examplePath) ? readFileSync(examplePath, 'utf8') : '';

  // `replaceOrAppend` performs the substitution and returns whether the
  // pattern matched. If a customised .env.example dropped one of the keys
  // we expect, we append the canonical line at the bottom rather than
  // letting the value silently disappear.
  const appended: string[] = [];
  function replaceOrAppend(re: RegExp, line: string): void {
    if (re.test(envContent)) {
      envContent = envContent.replace(re, line);
    } else {
      appended.push(line);
    }
  }

  replaceOrAppend(/^AGENT_MODE=.*$/m, `AGENT_MODE=${mode}`);
  replaceOrAppend(/^AGENT_KEYPAIR=.*$/m, `AGENT_KEYPAIR=${agentKeypair}`);
  replaceOrAppend(
    /^# ?ANTHROPIC_API_KEY=.*$/m,
    `${providerKey === 'ANTHROPIC_API_KEY' ? '' : '# '}ANTHROPIC_API_KEY=${providerKey === 'ANTHROPIC_API_KEY' ? llmKey : ''}`,
  );
  replaceOrAppend(
    /^# ?OPENAI_API_KEY=.*$/m,
    `${providerKey === 'OPENAI_API_KEY' ? '' : '# '}OPENAI_API_KEY=${providerKey === 'OPENAI_API_KEY' ? llmKey : ''}`,
  );
  replaceOrAppend(
    /^# ?GOOGLE_GENERATIVE_AI_API_KEY=.*$/m,
    `${providerKey === 'GOOGLE_GENERATIVE_AI_API_KEY' ? '' : '# '}GOOGLE_GENERATIVE_AI_API_KEY=${providerKey === 'GOOGLE_GENERATIVE_AI_API_KEY' ? llmKey : ''}`,
  );
  replaceOrAppend(/^WALLET_ALLOWLIST=.*$/m, `WALLET_ALLOWLIST=${walletAllowlist}`);
  replaceOrAppend(
    /^# ?BOOTSTRAP_WALLET=.*$/m,
    bootstrapWallet ? `BOOTSTRAP_WALLET=${bootstrapWallet}` : '# BOOTSTRAP_WALLET=',
  );
  // AGENT_PERSONA — only emit a non-comment line when the operator picked
  // a non-default persona, so a freshly-set-up .env stays minimal.
  replaceOrAppend(
    /^# ?AGENT_PERSONA=.*$/m,
    agentPersona === 'default' ? '# AGENT_PERSONA=default' : `AGENT_PERSONA=${agentPersona}`,
  );

  // LLM_MODEL is optional in the slim example (defaults to Anthropic Claude).
  // Only write a line when the operator picked a non-default provider.
  if (llmModel !== 'anthropic/claude-sonnet-4-5-20250929') {
    if (/^LLM_MODEL=/m.test(envContent)) {
      envContent = envContent.replace(/^LLM_MODEL=.*$/m, `LLM_MODEL=${llmModel}`);
    } else {
      appended.push(`LLM_MODEL=${llmModel}`);
    }
  }

  if (appended.length > 0) {
    if (!envContent.endsWith('\n')) envContent += '\n';
    envContent += '\n# --- appended by `pnpm setup` (key not found in .env.example) ---\n';
    envContent += appended.join('\n') + '\n';
  }

  writeFileSync(envPath, envContent, { mode: 0o600 });
  // writeFileSync's `mode` only applies on file creation; an overwrite of
  // an existing .env preserves whatever permissions were there before.
  // Force 0600 explicitly so the secret-bearing file always lands locked
  // down regardless of prior state.
  chmodSync(envPath, 0o600);
  console.log(`\n  wrote ${envPath} (chmod 0600)`);
  if (appended.length > 0) {
    console.log(`  (${appended.length} key${appended.length === 1 ? '' : 's'} appended because .env.example was missing the placeholder line)`);
  }

  // 7. wallets.allowlist.json
  if (mode === 'public' && walletAllowlist) {
    const allowlistPath = resolve(ROOT, 'wallets.allowlist.json');
    let seedAllowlist = !existsSync(allowlistPath);
    if (!seedAllowlist) {
      // File already exists — confirm before clobbering. We've already closed
      // the readline interface above, so open a fresh one for this prompt.
      const confirmRl = createInterface({ input, output });
      const answer = (await confirmRl.question(
        `  ${allowlistPath} already exists — overwrite with [{ "wallets": ["${walletAllowlist}"] }]? [y/N]: `,
      )).trim().toLowerCase();
      confirmRl.close();
      seedAllowlist = answer === 'y' || answer === 'yes';
    }
    if (seedAllowlist) {
      writeFileSync(
        allowlistPath,
        JSON.stringify({ wallets: [walletAllowlist] }, null, 2) + '\n',
      );
      console.log(`  wrote ${allowlistPath}`);
    } else {
      console.log(`  kept existing ${allowlistPath} unchanged`);
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
