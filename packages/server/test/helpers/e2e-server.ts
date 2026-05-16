/**
 * End-to-end test harness for the PlexChat WebSocket server.
 *
 * Spins up a real `PlexChatServer` on an ephemeral port with:
 *   - a stub Mastra agent (no real LLM calls — scripted chunks)
 *   - a mock Solana RPC server (in-process HTTP)
 *   - a fresh agent keypair per server
 *   - configurable auth mode + allowlist
 *
 * Each call to `startTestServer()` returns a self-contained environment
 * the test owns and closes. Multiple servers can run concurrently in the
 * same test file because each binds to its own ephemeral port; the
 * underlying config singleton is reset per server start so env-driven
 * settings (auth mode, RPC URL, etc.) take effect.
 */

import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { WebSocket } from 'ws';
import { mkdtempSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  _resetConfigForTests,
  clearOwnerCache,
  buildSiwsMessage,
  type SiwsParams,
  type ServerMessage,
  type ServerAuthChallenge,
  type ServerConnected,
  type ServerAuthenticated,
} from '@metaplex-foundation/shared';
import { startMockRpc, blockhashFixture, type MockRpc } from '../../../shared/test/helpers/mock-rpc.js';
import { defaultTestEnv, isolateEnv, restoreEnv } from '../../../shared/test/helpers/env.js';
import { makeStreamingStubAgent, type StreamingStubAgent } from './stub-streaming-agent.js';
import { PlexChatServer } from '../../src/websocket.js';

// state.ts caches the resolved state path at module scope on first call,
// which means we have to set CWD to a clean directory BEFORE any other test
// helper touches state. We do this once per process — the directory persists
// for the test process lifetime — and wipe agent-state.json between servers.
let _stateTmpDir: string | null = null;
let _originalCwd: string | null = null;
function ensureCleanStateDir(): string {
  if (_stateTmpDir) {
    // Wipe the per-process state file so each server boot starts clean.
    const f = join(_stateTmpDir, 'agent-state.json');
    if (existsSync(f)) unlinkSync(f);
    return _stateTmpDir;
  }
  _originalCwd = process.cwd();
  _stateTmpDir = mkdtempSync(join(tmpdir(), 'plexchat-e2e-'));
  // Plant a workspace marker so state.ts anchors here rather than walking up.
  writeFileSync(join(_stateTmpDir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  process.chdir(_stateTmpDir);
  return _stateTmpDir;
}

export interface TestServerEnv {
  url: string;
  port: number;
  agent: StreamingStubAgent;
  rpc: MockRpc;
  server: PlexChatServer;
  ownerKeypair: nacl.SignKeyPair;
  ownerWallet: string;
  agentKeypair: nacl.SignKeyPair;
  close(): Promise<void>;
}

export interface StartTestServerOptions {
  /**
   * Auth tier policy. Defaults to `'open'` so any wallet can authenticate
   * without pre-staging an allowlist.
   */
  authMode?: 'open' | 'owner' | 'allowlist';
  /** File-managed allowlist seed. Only consulted in `allowlist` mode. */
  allowlist?: string[];
  /** Public or autonomous mode. Defaults to `public`. */
  agentMode?: 'public' | 'autonomous';
  /** Additional env vars merged into the test env. */
  extraEnv?: Record<string, string>;
  /** Enable debug events on the server. Default `false` (off) so tests aren't drowning in chunks. */
  enableDebugEvents?: boolean;
  /** Override the per-connection per-session rate limiter window/max. */
  rateLimitMax?: number;
}

/**
 * Boots a `PlexChatServer` configured for end-to-end testing. Returns a
 * harness object the test can use to drive the WebSocket protocol.
 */
export async function startTestServer(opts: StartTestServerOptions = {}): Promise<TestServerEnv> {
  // Anchor on-disk state inside a per-process tmpdir so we don't pick up
  // the workspace's real agent-state.json (which has a registered asset
  // address that would trigger spurious resolveOwner RPC calls).
  ensureCleanStateDir();

  // --- Fresh keypairs per server -----------------------------------------
  const agentKeypair = nacl.sign.keyPair();
  const ownerKeypair = nacl.sign.keyPair();
  const ownerWallet = bs58.encode(ownerKeypair.publicKey);
  const agentKeypairJson = JSON.stringify(Array.from(agentKeypair.secretKey));

  // --- Mock RPC ----------------------------------------------------------
  const rpc = await startMockRpc();
  // The preflight does getSlot(); resolveOwner doesn't hit RPC because we
  // leave AGENT_ASSET_ADDRESS unset and rely on BOOTSTRAP_WALLET.
  rpc.on('getSlot', () => 1);
  rpc.on('getLatestBlockhash', () => blockhashFixture());
  rpc.on('getBalance', () => ({ context: { slot: 1 }, value: 0 }));
  rpc.on('getMinimumBalanceForRentExemption', () => 890_880);
  rpc.on('getAccountInfo', () => ({ context: { slot: 1 }, value: null }));

  // --- Env / config singleton --------------------------------------------
  // We deliberately do NOT call restoreEnv between servers — tests run
  // serially within a file, and isolateEnv saves+overrides per call. The
  // server's close() restores at the end.
  isolateEnv(
    defaultTestEnv({
      AGENT_MODE: opts.agentMode ?? 'public',
      AGENT_KEYPAIR: agentKeypairJson,
      SOLANA_RPC_URL: rpc.url,
      // BOOTSTRAP_WALLET lets resolveOwner return synchronously without
      // touching RPC, so we know exactly which wallet the server treats as
      // the owner. In `owner` mode this is the only wallet that can auth.
      BOOTSTRAP_WALLET: ownerWallet,
      AGENT_AUTH_MODE: opts.authMode ?? 'open',
      // Default origin allowlist permits the local dev UI; tests connect
      // without an Origin header which the server explicitly allows.
      WS_ALLOWED_ORIGINS: 'http://localhost:3001',
      ENABLE_DEBUG_EVENTS: opts.enableDebugEvents ? 'true' : 'false',
      // Generous handshake window so slow CI doesn't trip the auth_timeout.
      AUTH_HANDSHAKE_TIMEOUT_MS: '15000',
      // Pre-seed file allowlist via env (no file write needed).
      ...(opts.authMode === 'allowlist' && opts.allowlist?.length
        ? { WALLET_ALLOWLIST: opts.allowlist.join(',') }
        : {}),
      ...(opts.extraEnv ?? {}),
    }),
  );
  _resetConfigForTests();
  clearOwnerCache();

  // --- Stub agent --------------------------------------------------------
  const agent = makeStreamingStubAgent();

  // --- Server ------------------------------------------------------------
  const server = new PlexChatServer({ agent: agent as any, port: 0 });
  await server.start();
  await server.whenReady();
  const port = server.getPort();
  if (port === null) throw new Error('test server did not bind a port');

  return {
    url: `ws://127.0.0.1:${port}`,
    port,
    agent,
    rpc,
    server,
    ownerKeypair,
    ownerWallet,
    agentKeypair,
    async close() {
      try {
        await server.stop();
      } finally {
        await rpc.close();
        restoreEnv();
        _resetConfigForTests();
        clearOwnerCache();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// WebSocket client helpers
// ---------------------------------------------------------------------------

export interface AuthenticatedClient {
  socket: WebSocket;
  sessionId: string;
  walletAddress: string;
  /** Drain queue of every server-sent message received so far. */
  received: ServerMessage[];
  /** Wait for the next message of `type` (consumes from `received`). */
  waitFor<T extends ServerMessage['type']>(type: T, timeoutMs?: number): Promise<Extract<ServerMessage, { type: T }>>;
  /** Send a JSON message to the server. */
  send(msg: unknown): void;
  close(): Promise<void>;
}

/**
 * Open a fresh WebSocket connection, walk the SIWS handshake, and return
 * an authenticated client wired with a generic `received` queue + a
 * `waitFor(type)` helper for ergonomic assertions.
 */
export async function connectAuthenticated(
  env: TestServerEnv,
  walletKeypair: nacl.SignKeyPair = env.ownerKeypair,
): Promise<AuthenticatedClient> {
  const client = await openClient(env);
  // Drain the `connected` message (always emitted by the server).
  const connected = await client.waitFor('connected');
  if (!connected.jid) throw new Error('connected message missing jid');

  // SIWS challenge -----------------------------------------------------------
  const challenge = await client.waitFor('auth_challenge');
  const canonical: SiwsParams = {
    agentName: challenge.agentName,
    agentAsset: challenge.agentAsset,
    network: challenge.network,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  };
  const message = buildSiwsMessage(canonical);
  const messageBytes = new TextEncoder().encode(message);
  const signature = nacl.sign.detached(messageBytes, walletKeypair.secretKey);
  const publicKey = bs58.encode(walletKeypair.publicKey);

  client.send({
    type: 'auth_response',
    publicKey,
    signature: bs58.encode(signature),
    message,
  });

  const authed = (await client.waitFor('authenticated')) as ServerAuthenticated;
  return {
    socket: client.socket,
    sessionId: authed.sessionId,
    walletAddress: authed.walletAddress,
    received: client.received,
    waitFor: client.waitFor,
    send: client.send,
    close: client.close,
  };
}

/**
 * Open a raw WebSocket and wire the message queue. The connection is not
 * authenticated — callers that want SIWS-authed connections should use
 * `connectAuthenticated()`. Useful for testing auth-failure paths.
 */
export async function openClient(env: TestServerEnv): Promise<AuthenticatedClient> {
  // We pass an Origin header that's in the test env's allowlist. The
  // server tolerates undefined Origins (non-browser clients) too; sending
  // an explicit allowed value exercises the verifyClient path.
  const socket = new WebSocket(env.url, { headers: { Origin: 'http://localhost:3001' } });
  const received: ServerMessage[] = [];
  const waiters: Array<{
    type: string;
    resolve: (msg: ServerMessage) => void;
    reject: (err: Error) => void;
  }> = [];

  socket.on('message', (data) => {
    let parsed: ServerMessage;
    try {
      parsed = JSON.parse(data.toString()) as ServerMessage;
    } catch {
      return; // ignore non-JSON frames in tests
    }
    received.push(parsed);
    for (let i = 0; i < waiters.length; i++) {
      const w = waiters[i]!;
      if (parsed.type === w.type) {
        waiters.splice(i, 1);
        w.resolve(parsed);
        return;
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  function waitFor<T extends ServerMessage['type']>(type: T, timeoutMs = 5000):
    Promise<Extract<ServerMessage, { type: T }>>
  {
    // First check the existing queue — receivers might already have the message.
    for (let i = 0; i < received.length; i++) {
      if (received[i]!.type === type) {
        return Promise.resolve(received.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>);
      }
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolveTyped);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`timed out waiting for ${type} after ${timeoutMs}ms (received: ${received.map((m) => m.type).join(',')})`));
      }, timeoutMs);
      const resolveTyped = (msg: ServerMessage) => {
        clearTimeout(t);
        // Remove from received queue if present (waitFor may have raced the receiver).
        const idx = received.indexOf(msg);
        if (idx >= 0) received.splice(idx, 1);
        resolve(msg as Extract<ServerMessage, { type: T }>);
      };
      waiters.push({ type, resolve: resolveTyped, reject });
    });
  }

  function send(msg: unknown): void {
    socket.send(JSON.stringify(msg));
  }

  async function close(): Promise<void> {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close();
      });
    }
  }

  return {
    socket,
    sessionId: '',
    walletAddress: '',
    received,
    waitFor,
    send,
    close,
  };
}

/**
 * Re-exported for tests that need to construct expected canonical SIWS
 * messages without going through `connectAuthenticated`.
 */
export { buildSiwsMessage } from '@metaplex-foundation/shared';
export type { ServerConnected, ServerAuthChallenge, ServerAuthenticated } from '@metaplex-foundation/shared';
