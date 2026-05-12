#!/usr/bin/env tsx
/**
 * SIWS auth handshake end-to-end smoke test.
 *
 * Connects to a running PlexChat server, signs the canonical SIWS challenge
 * with a synthetic (or operator-supplied) Solana keypair, and prints whatever
 * the server sends back. Use this to verify the wiring works against a real
 * running server, in any of the three auth modes (open / allowlist / owner).
 *
 * Usage:
 *   pnpm tsx scripts/smoke-siws.ts                  # random keypair (open / allowlist-deny)
 *   pnpm tsx scripts/smoke-siws.ts --owner-keypair  # use AGENT_KEYPAIR from env (owner mode)
 *
 * Environment:
 *   WS_URL          ws URL to dial    (default: ws://localhost:3002)
 *   WS_ORIGIN       Origin header     (default: http://localhost:3001)
 *   OWNER_KEYPAIR   override AGENT_KEYPAIR for the operator-mode test
 *   AGENT_KEYPAIR   read when --owner-keypair is passed and OWNER_KEYPAIR is unset
 *
 * The keypair format matches AGENT_KEYPAIR in `packages/shared/src/config.ts`:
 *   - JSON byte array of length 64, e.g. [12, 34, ...]
 *   - 64-byte base58-encoded secret key
 *
 * The script exits 0 on `authenticated`, non-zero on `auth_error` or close
 * code other than 1000. This makes it reasonable to chain in a CI script.
 */

import WebSocket from 'ws';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { buildSiwsMessage } from '@metaplex-foundation/shared';

const WS_URL = process.env.WS_URL ?? 'ws://localhost:3002';
const WS_ORIGIN = process.env.WS_ORIGIN ?? 'http://localhost:3001';

// --- keypair selection ---------------------------------------------------

interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

function decodeOperatorKeypair(raw: string): KeyPair {
  const trimmed = raw.trim();
  let secretKey: Uint8Array;
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255)
    ) {
      throw new Error('Operator keypair JSON must be a length-64 array of bytes (0-255).');
    }
    secretKey = new Uint8Array(parsed as number[]);
  } else {
    const decoded = bs58.decode(trimmed);
    if (decoded.length !== 64) {
      throw new Error(`Operator keypair base58 decoded to ${decoded.length} bytes, expected 64.`);
    }
    secretKey = decoded;
  }
  // tweetnacl recovers the public key from the 64-byte secret key.
  const kp = nacl.sign.keyPair.fromSecretKey(secretKey);
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

const wantsOwner = process.argv.includes('--owner-keypair');
let kp: KeyPair;
if (wantsOwner) {
  const raw = process.env.OWNER_KEYPAIR ?? process.env.AGENT_KEYPAIR;
  if (!raw) {
    console.error(
      '--owner-keypair was passed but neither OWNER_KEYPAIR nor AGENT_KEYPAIR is set in the environment.',
    );
    process.exit(2);
  }
  try {
    kp = decodeOperatorKeypair(raw);
  } catch (err) {
    console.error('Failed to decode operator keypair:', err instanceof Error ? err.message : err);
    process.exit(2);
  }
  console.log('using operator keypair from env');
} else {
  const random = nacl.sign.keyPair();
  kp = { publicKey: random.publicKey, secretKey: random.secretKey };
  console.log('using random keypair (pass --owner-keypair to test owner mode)');
}

const pubkeyBase58 = bs58.encode(kp.publicKey);
console.log(`pubkey: ${pubkeyBase58}`);
console.log(`dialing ${WS_URL} (Origin: ${WS_ORIGIN})`);

// --- handshake -----------------------------------------------------------

let exitCode = 1; // pessimistic: anything other than `authenticated` is a failure
const ws = new WebSocket(WS_URL, { origin: WS_ORIGIN });

ws.on('open', () => {
  console.log('-> open');
});

ws.on('message', (raw) => {
  let msg: { type?: string; [k: string]: unknown };
  try {
    msg = JSON.parse(raw.toString());
  } catch (err) {
    console.error('<- (invalid JSON)', raw.toString(), err);
    return;
  }
  console.log('<-', msg.type, msg);

  if (msg.type === 'auth_challenge') {
    // Use the shared canonical builder so any future format change is
    // picked up automatically — no risk of the smoke script and the server
    // drifting because the script reimplemented the formatting by hand.
    const m = buildSiwsMessage({
      agentName: String(msg.agentName),
      agentAsset: (msg.agentAsset ?? null) as string | null,
      network: msg.network as 'solana-mainnet' | 'solana-devnet',
      nonce: String(msg.nonce),
      issuedAt: String(msg.issuedAt),
      expiresAt: String(msg.expiresAt),
    });
    const sig = nacl.sign.detached(new TextEncoder().encode(m), kp.secretKey);
    ws.send(
      JSON.stringify({
        type: 'auth_response',
        publicKey: pubkeyBase58,
        signature: bs58.encode(sig),
        message: m,
      }),
    );
    return;
  }

  if (msg.type === 'authenticated') {
    exitCode = 0;
    // Give the server a moment to flush any follow-up frames, then exit.
    setTimeout(() => {
      ws.close(1000, 'smoke test complete');
      process.exit(exitCode);
    }, 250);
    return;
  }

  if (msg.type === 'auth_error') {
    // Server will close 4001 right after; let `close` log it and exit.
    return;
  }
});

ws.on('error', (err) => {
  console.error('-- error', err.message);
});

ws.on('close', (code, reason) => {
  console.log(`-- close code=${code} reason=${reason.toString() || '(empty)'}`);
  process.exit(exitCode);
});

// Hard timeout — if the server never responds, don't hang forever.
setTimeout(() => {
  console.error('-- timeout: no terminal frame within 10s');
  ws.terminate();
  process.exit(3);
}, 10_000).unref();
