#!/usr/bin/env tsx
/**
 * pnpm doctor — pre-flight diagnostics for the agent template.
 *
 * Validates the local setup and surfaces anything wrong before the operator
 * tries to chat. Exit code 0 = ready to run; non-zero = at least one issue.
 *
 * Checks (each is a separate "row" in the report):
 *   1. .env presence + Zod validation
 *   2. AGENT_KEYPAIR decodes; print pubkey + PDA + balances
 *   3. SOLANA_RPC_URL reachable (cheap getSlot probe)
 *   4. LLM API key present (presence-only — no paid call)
 *   5. wallets.allowlist.json (if path is set) parses
 *   6. Railway / ephemeral-fs warning when running on a hosted platform
 *   7. SIWS smoke test against ws://localhost:<port> if the server is running
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

type Status = 'ok' | 'warn' | 'fail' | 'skip';

interface Row {
  name: string;
  status: Status;
  detail: string;
}

const rows: Row[] = [];

function add(name: string, status: Status, detail: string): void {
  rows.push({ name, status, detail });
}

function symbol(s: Status): string {
  switch (s) {
    case 'ok': return '\u2713'; // ✓
    case 'warn': return '!';
    case 'fail': return '\u2717'; // ✗
    case 'skip': return '-';
  }
}

function color(s: Status): (text: string) => string {
  if (!process.stdout.isTTY) return (t) => t;
  const codes: Record<Status, string> = {
    ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', skip: '\x1b[90m',
  };
  return (t) => `${codes[s]}${t}\x1b[0m`;
}

// ---- 1. .env presence + Zod validation ----
async function checkEnv(): Promise<void> {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) {
    add('.env file', 'fail', `not found at ${envPath} — copy .env.example then edit, or run \`pnpm setup\``);
    return;
  }
  add('.env file', 'ok', envPath);

  try {
    const { getConfig } = await import('@metaplex-agent/shared');
    const cfg = getConfig();
    add('config validation', 'ok', `AGENT_MODE=${cfg.AGENT_MODE}, AGENT_AUTH_MODE=${cfg.AGENT_AUTH_MODE}`);
    return;
  } catch (err) {
    add('config validation', 'fail', err instanceof Error ? err.message.split('\n')[0] : String(err));
  }
}

// ---- 2. AGENT_KEYPAIR + balances ----

/**
 * Format a lamports balance (Umi's `basisPoints`) as a fixed-precision SOL
 * string without going through the Number / 1e9 path. Lamports values can
 * exceed Number.MAX_SAFE_INTEGER (2^53-1 ≈ 9e15) for whale wallets — Solana
 * total supply is ~5.89e17 lamports — so the lossy float divide can drop
 * trailing digits. Doing the divide entirely in BigInt keeps every digit
 * exact.
 */
function formatSol(basisPoints: bigint | number | string | null | undefined, fractionDigits = 4): string {
  if (basisPoints === null || basisPoints === undefined) return '0.0000 SOL';
  let bp: bigint;
  try {
    bp = typeof basisPoints === 'bigint' ? basisPoints : BigInt(basisPoints);
  } catch {
    return 'unknown SOL';
  }
  const negative = bp < 0n;
  const abs = negative ? -bp : bp;
  const LAMPORTS_PER_SOL = 1_000_000_000n;
  const whole = abs / LAMPORTS_PER_SOL;
  const remainder = abs % LAMPORTS_PER_SOL; // 0 .. 999_999_999
  const fracStr = remainder.toString().padStart(9, '0').slice(0, fractionDigits);
  const sign = negative ? '-' : '';
  return `${sign}${whole.toString()}.${fracStr} SOL`;
}

async function checkKeypair(): Promise<void> {
  try {
    const { createUmi, getAgentPda, getConfig } = await import('@metaplex-agent/shared');
    const { publicKey } = await import('@metaplex-foundation/umi');
    const cfg = getConfig();
    const umi = createUmi();
    const kpAddr = umi.identity.publicKey.toString();
    const kpBal = formatSol((await umi.rpc.getBalance(umi.identity.publicKey)).basisPoints);
    add('agent keypair', 'ok', `${kpAddr} (${kpBal})`);
    if (cfg.AGENT_ASSET_ADDRESS) {
      const pda = getAgentPda(umi, publicKey(cfg.AGENT_ASSET_ADDRESS));
      const pdaBal = formatSol((await umi.rpc.getBalance(pda)).basisPoints);
      add('agent PDA', 'ok', `${pda.toString()} (${pdaBal})`);
    } else {
      add('agent PDA', 'skip', 'not registered yet (AGENT_ASSET_ADDRESS unset)');
    }
  } catch (err) {
    add('agent keypair', 'fail', err instanceof Error ? err.message : String(err));
  }
}

// ---- 3. RPC reachability ----
async function checkRpc(): Promise<void> {
  try {
    const { createUmi, getConfig } = await import('@metaplex-agent/shared');
    const cfg = getConfig();
    const umi = createUmi();
    const slot = await umi.rpc.getSlot();
    add('Solana RPC', 'ok', `${cfg.SOLANA_RPC_URL} (slot ${slot})`);
  } catch (err) {
    add('Solana RPC', 'fail', err instanceof Error ? err.message : String(err));
  }
}

// ---- 4. LLM key presence ----
async function checkLlmKey(): Promise<void> {
  try {
    const { getConfig } = await import('@metaplex-agent/shared');
    const cfg = getConfig();
    const provider = cfg.LLM_MODEL.split('/')[0]?.toLowerCase();
    const map: Record<string, string> = {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      google: 'GOOGLE_GENERATIVE_AI_API_KEY',
    };
    const expected = provider ? map[provider] : undefined;
    if (!expected) {
      add('LLM key', 'skip', `unknown provider "${provider}" — no key check performed`);
      return;
    }
    const value = process.env[expected];
    if (!value) {
      add('LLM key', 'fail', `${expected} not set (required by LLM_MODEL=${cfg.LLM_MODEL})`);
      return;
    }
    // Presence-only — don't burn API credits with a real probe call.
    add('LLM key', 'ok', `${expected} present (${value.length} chars)`);
  } catch {
    add('LLM key', 'skip', 'config invalid; rerun after fixing .env');
  }
}

// ---- 5. wallets.allowlist.json parses (if used) ----
async function checkAllowlist(): Promise<void> {
  try {
    const { getConfig } = await import('@metaplex-agent/shared');
    const cfg = getConfig();
    const path = resolve(ROOT, cfg.WALLET_ALLOWLIST_PATH);
    if (!existsSync(path)) {
      add('allowlist file', 'skip', `${cfg.WALLET_ALLOWLIST_PATH} not present (env-only allowlist or open mode)`);
      return;
    }
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { wallets?: unknown };
    if (!Array.isArray(parsed.wallets) || !parsed.wallets.every((w) => typeof w === 'string')) {
      add('allowlist file', 'fail', `${path} does not match { "wallets": string[] }`);
      return;
    }
    add('allowlist file', 'ok', `${path} (${parsed.wallets.length} entries)`);
  } catch (err) {
    add('allowlist file', 'fail', err instanceof Error ? err.message : String(err));
  }
}

// ---- 6. Hosting platform sniff ----
function checkHostingPlatform(): void {
  if (process.env.RAILWAY_ENVIRONMENT) {
    add(
      'hosting',
      'warn',
      'detected Railway. Note: container fs is ephemeral — agent-state.json is wiped on every redeploy. ' +
      'Copy AGENT_ASSET_ADDRESS into env vars after first registration to avoid re-registering.',
    );
  } else if (process.env.FLY_APP_NAME) {
    add('hosting', 'warn', 'detected Fly. Mount a volume at /app/agent-state.json or persist via env vars.');
  } else {
    add('hosting', 'skip', 'no managed-platform indicators detected');
  }
}

// ---- 7. SIWS smoke against running server ----
async function checkSiwsSmoke(): Promise<void> {
  try {
    const { getConfig } = await import('@metaplex-agent/shared');
    const cfg = getConfig();
    const port = cfg.WEB_CHANNEL_PORT;
    const ws = await import('ws');
    const nacl = (await import('tweetnacl')).default;
    const { default: bs58 } = await import('bs58');
    const { buildSiwsMessage } = await import('@metaplex-agent/shared');

    const kp = nacl.sign.keyPair();
    const pubkeyBase58 = bs58.encode(kp.publicKey);

    await new Promise<void>((resolveDone, rejectDone) => {
      const sock = new ws.WebSocket(`ws://localhost:${port}`, {
        origin: cfg.WS_ALLOWED_ORIGINS[0] ?? 'http://localhost:3001',
      });
      let resolved = false;
      const finish = (cb: () => void) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        cb();
      };
      const timer = setTimeout(() => {
        sock.terminate();
        finish(() => rejectDone(new Error(`no terminal frame within 5s on ws://localhost:${port}`)));
      }, 5000);
      sock.on('error', (err) => {
        finish(() => rejectDone(err));
      });
      sock.on('close', (code, reason) => {
        // If the server closes the socket before we observed a terminal
        // frame (auth_challenge → authenticated/auth_error), surface that
        // as a warning rather than letting the 5s timer expire silently.
        finish(() => {
          add(
            'SIWS smoke',
            'warn',
            `socket closed (code=${code}, reason=${reason.toString() || '(empty)'}) before completing handshake`,
          );
          resolveDone();
        });
      });
      sock.on('message', (raw) => {
        const rawText = raw.toString();
        let msg: { type?: string; [k: string]: unknown };
        try {
          msg = JSON.parse(rawText);
        } catch (parseErr) {
          finish(() => {
            const detail = parseErr instanceof Error ? parseErr.message : String(parseErr);
            add(
              'SIWS smoke',
              'warn',
              `server sent invalid JSON: ${detail} (first 80 chars: ${rawText.slice(0, 80)})`,
            );
            sock.close();
            resolveDone();
          });
          return;
        }
        if (msg.type === 'auth_challenge') {
          const m = buildSiwsMessage({
            agentName: msg.agentName,
            agentAsset: msg.agentAsset ?? null,
            network: msg.network,
            nonce: msg.nonce,
            issuedAt: msg.issuedAt,
            expiresAt: msg.expiresAt,
          });
          const sig = nacl.sign.detached(new TextEncoder().encode(m), kp.secretKey);
          sock.send(JSON.stringify({
            type: 'auth_response',
            publicKey: pubkeyBase58,
            signature: bs58.encode(sig),
            message: m,
          }));
        } else if (msg.type === 'authenticated') {
          finish(() => {
            add('SIWS smoke', 'ok', `auth_challenge → authenticated (authMode=${msg.isOwner ? 'owner' : 'non-owner'} pubkey)`);
            sock.close(1000, 'doctor');
            resolveDone();
          });
        } else if (msg.type === 'auth_error') {
          finish(() => {
            add('SIWS smoke', 'warn', `auth_error: ${msg.code} — server is up and SIWS-wired, deny path is correct for a random keypair`);
            sock.close();
            resolveDone();
          });
        }
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED')) {
      add('SIWS smoke', 'skip', 'server not running on configured port — start it with `pnpm dev` to include this check');
    } else {
      add('SIWS smoke', 'warn', msg);
    }
  }
}

// ---- main ----
async function main(): Promise<void> {
  await checkEnv();
  // The remaining checks need a valid config; if the first one failed, skip downstream gracefully.
  const envOk = rows.find((r) => r.name === 'config validation')?.status === 'ok';
  if (envOk) {
    await checkRpc();
    await checkKeypair();
    await checkLlmKey();
    await checkAllowlist();
    checkHostingPlatform();
    await checkSiwsSmoke();
  }

  // Render
  console.log('\nMetaplex Agent Template — pnpm doctor\n');
  const nameWidth = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    const c = color(r.status);
    console.log(`  ${c(symbol(r.status))} ${r.name.padEnd(nameWidth)}  ${r.detail}`);
  }
  console.log();

  const failed = rows.filter((r) => r.status === 'fail');
  const warned = rows.filter((r) => r.status === 'warn');
  if (failed.length > 0) {
    console.log(`${color('fail')(`${failed.length} blocker${failed.length === 1 ? '' : 's'}`)} — fix before running.`);
    process.exit(1);
  }
  if (warned.length > 0) {
    console.log(`${color('warn')(`${warned.length} warning${warned.length === 1 ? '' : 's'}`)} — agent will start but read each warning.`);
    process.exit(0);
  }
  console.log(`${color('ok')('All checks passed.')} You're ready to \`pnpm dev:full\`.`);
}

main().catch((err) => {
  console.error('[doctor] unexpected error:', err);
  process.exit(2);
});
