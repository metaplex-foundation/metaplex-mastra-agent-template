import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { createServer, type Server as HttpServer } from 'http';
import { randomUUID } from 'crypto';
import { publicKey } from '@metaplex-foundation/umi';
import {
  getConfig,
  getServerLimits,
  resolveOwner,
  createUmi,
  getAgentKeypairPublicKey,
  getAgentPda,
  buildSiwsMessage,
  verifySiwsSignature,
  NonceStore,
  isAuthorized,
  AllowlistFile,
  WalletRateLimiter,
  type SiwsParams,
  type ServerMessage,
  type TransactionSender,
  type AgentContext,
  type ClientMessage,
  type ClientAuthResponse,
  type ServerAuthChallenge,
  type ServerAuthError,
} from '@metaplex-agent/shared';
import { createAgent, publicToolNames, autonomousToolNames } from '@metaplex-agent/core';
import { RequestContext } from '@mastra/core/request-context';
import { Session, type SimpleRateLimiter } from './session.js';
import {
  isDashboardRequest,
  handleDashboardRequest,
} from './dashboard.js';

// Split regexes for different base58 contexts
const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

// Tx approval timeout (5 minutes). Long enough for slow networks / user
// attention lapses; short enough that a forgotten tab doesn't leak forever.
const TX_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

// Sanitizer for user-supplied error reasons — allow safe punctuation, letters, digits, spaces
const SAFE_REASON_RE = /^[\w\s.,:;'"()?!\-]{0,200}$/;

/**
 * Strip characters that could close / inject into the `[Agent: … | User wallet: X]`
 * prefix the agent sees (C1). Also caps length so an attacker can't pad it
 * into context bloat. 88 chars comfortably holds any valid base58 address.
 */
function sanitizeForPrefix(s: string): string {
  return s.replace(/[\[\]\r\n]/g, '').slice(0, 88);
}

/**
 * Simple per-connection rate limiter using a sliding window.
 */
class RateLimiter implements SimpleRateLimiter {
  private timestamps: number[] = [];
  constructor(private maxMessages: number, private windowMs: number) {}

  allow(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxMessages) return false;
    this.timestamps.push(now);
    return true;
  }
}

/**
 * Build a chat-template share link that pre-fills the agent profile, so the
 * operator can click straight from the server's startup log into a working
 * chat session without going through the profile-setup step.
 *
 * Format mirrors `encodeProfileToHash` in
 * metaplex-agent-chat-template/src/lib/share-link.ts — keep them in sync.
 */
function buildTestUiUrl(args: {
  uiOrigin: string;
  wsPort: number;
  rpcUrl: string;
  name: string;
}): string {
  const params = new URLSearchParams();
  params.set('ws', `ws://localhost:${args.wsPort}`);
  const preset = inferRpcPreset(args.rpcUrl);
  params.set('preset', preset);
  if (preset === 'custom') {
    params.set('rpc', args.rpcUrl);
    params.set('cluster', 'devnet');
  }
  params.set('name', args.name);
  return `${args.uiOrigin}/#${params.toString()}`;
}

function inferRpcPreset(rpcUrl: string): 'mainnet' | 'devnet' | 'localnet' | 'custom' {
  try {
    const url = new URL(rpcUrl);
    if (url.hostname === 'api.mainnet-beta.solana.com') return 'mainnet';
    if (url.hostname === 'api.devnet.solana.com') return 'devnet';
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return 'localnet';
    return 'custom';
  } catch {
    return 'custom';
  }
}

/**
 * PlexChat WebSocket Server
 *
 * Implements the PlexChat protocol for real-time communication between
 * web frontends and the Mastra agent. All per-connection state lives on
 * a `Session` object; the server only holds shared resources (agent,
 * owner cache, connection map, ping interval).
 */
export class PlexChatServer {
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private sessions: Map<WebSocket, Session> = new Map();
  private ownerWallet: string | null = null;
  private agent: ReturnType<typeof createAgent>;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private nonceSweepInterval: ReturnType<typeof setInterval> | null = null;
  private nonceStore: NonceStore;
  private allowlistFile: AllowlistFile;
  private walletLimiter: WalletRateLimiter;
  private stopped = false;
  // Resolves once start() has finished its async preflight + owner-resolution
  // phase. Lets the orchestrator (index.ts) wait before booting the worker
  // loop so the loop's first tick has a populated ownerWallet.
  private readyPromise: Promise<void>;
  private resolveReady: () => void = () => {};

  private static readonly MAX_HISTORY = 50;

  constructor() {
    this.agent = createAgent();
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
    const config = getConfig();
    this.nonceStore = new NonceStore({ ttlMs: config.AUTH_NONCE_TTL_MS });
    this.allowlistFile = new AllowlistFile({
      // Path is operator-configurable (WALLET_ALLOWLIST_PATH); defaults to
      // 'wallets.allowlist.json' at process.cwd() — same convention as
      // agent-state.json. Cloud deploys (Railway/Fly/k8s) typically mount the
      // file at a different path and override via env.
      path: config.WALLET_ALLOWLIST_PATH,
      envFallback: config.WALLET_ALLOWLIST,
      pollIntervalMs: 5_000,
    });
    // Per-wallet sliding-window rate limiter. Owner exemption is initialized
    // to null and updated in start() once resolveOwner() resolves — the
    // constructor is sync but owner resolution is async.
    this.walletLimiter = new WalletRateLimiter({
      max: config.WALLET_RATE_LIMIT_MAX,
      windowMs: config.WALLET_RATE_LIMIT_WINDOW_MS,
      maxKeys: config.WALLET_RATE_LIMIT_MAX_KEYS,
      ownerExempt: null,
    });
  }

  /** Resolves once startup is complete (preflight + owner resolution done). */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  /** Returns the Mastra agent instance. Stable for the lifetime of the server. */
  getAgent(): ReturnType<typeof createAgent> {
    return this.agent;
  }

  /** Returns the resolved owner wallet, or null if resolution failed / not yet ready. */
  getOwnerWallet(): string | null {
    return this.ownerWallet;
  }

  /**
   * Start the WebSocket server on the configured port.
   *
   * Runs a startup preflight (M11) before binding the port:
   *   - Decode AGENT_KEYPAIR via createUmi() to catch malformed keys early.
   *   - Probe RPC connectivity with a cheap getSlot() call.
   * A failure in either is fatal — we log a clear message and exit(1)
   * rather than accepting connections against a broken backend.
   */
  async start(): Promise<void> {
    const config = getConfig();
    const port = config.WEB_CHANNEL_PORT;

    // --- Preflight: keypair ---
    try {
      createUmi();
    } catch (err) {
      console.error(
        'Startup preflight failed: AGENT_KEYPAIR could not be decoded.\n' +
        '  ' + (err instanceof Error ? err.message : String(err)) + '\n' +
        '  Hint: AGENT_KEYPAIR must be a 64-byte base58 secret key or a JSON byte array.',
      );
      process.exit(1);
    }

    // --- Preflight: RPC connectivity ---
    try {
      const umi = createUmi();
      await umi.rpc.getSlot();
    } catch (err) {
      console.error(
        'Startup preflight failed: could not reach Solana RPC.\n' +
        '  RPC URL: ' + config.SOLANA_RPC_URL + '\n' +
        '  Error: ' + (err instanceof Error ? err.message : String(err)) + '\n' +
        '  Hint: check SOLANA_RPC_URL in .env and your network connection.',
      );
      process.exit(1);
    }

    // Pass a request handler to createServer so plain HTTP requests (the
    // dashboard) get routed to our handler. WebSocket upgrade requests
    // bypass this — the WS server hooks the 'upgrade' event itself.
    this.httpServer = createServer((req, res) => {
      if (isDashboardRequest(req)) {
        handleDashboardRequest(req, res, this);
        return;
      }
      // 404 anything else so unrelated probes get a clean response rather
      // than hanging until the socket times out.
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });

    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: 64 * 1024, // 64 KB max message size
      // C2: Origin validation. We reject obviously-foreign browser origins
      // in the HTTP upgrade handshake, before the WebSocket is established.
      // Undefined origins (curl, ws CLIs, native clients) are allowed but
      // logged as a warning so operators notice unexpected sources.
      verifyClient: (info, cb) => {
        const origin = info.req.headers.origin;
        const allowed = config.WS_ALLOWED_ORIGINS;
        if (origin === undefined) {
          this.logAuthFailure('origin_missing_allowed', {
            note: 'non-browser client accepted',
            remote: info.req.socket.remoteAddress ?? null,
          });
          cb(true);
          return;
        }
        if (allowed.includes(origin)) {
          cb(true);
          return;
        }
        this.logAuthFailure('origin_rejected', {
          origin,
          remote: info.req.socket.remoteAddress ?? null,
        });
        cb(false, 403, 'Forbidden origin');
      },
    });

    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    this.wss.on('error', (err) => {
      console.error('WebSocket server error:', err.message);
    });

    // Ping/pong heartbeat to detect stale connections
    this.pingInterval = setInterval(() => {
      for (const [ws] of this.sessions) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }
    }, 30000);

    // Periodic nonce sweep to bound memory under SIWS-flood. The store is
    // unbounded by design; sweep evicts expired entries.
    this.nonceSweepInterval = setInterval(() => this.nonceStore.sweep(), 60_000);
    this.nonceSweepInterval.unref?.();

    this.httpServer.listen(port, async () => {
      console.log(`PlexChat WebSocket server running on ws://localhost:${port}`);
      console.log(`Agent mode: ${config.AGENT_MODE}`);
      console.log(`Agent name: ${config.ASSISTANT_NAME}`);
      console.log(`RPC: ${config.SOLANA_RPC_URL}`);
      // The chat template's `next dev` hardcodes :3001. If the operator
      // overrides that port locally, this URL won't match — but neither
      // would the previous bare `http://localhost:3001`, so we're not
      // making it worse.
      const testUiUrl = buildTestUiUrl({
        uiOrigin: 'http://localhost:3001',
        wsPort: port,
        rpcUrl: config.SOLANA_RPC_URL,
        name: config.ASSISTANT_NAME,
      });
      console.log(`Test UI (if running): ${testUiUrl}`);

      // Resolve owner at startup
      this.ownerWallet = await resolveOwner(config.AGENT_ASSET_ADDRESS ?? null);
      // Push the resolved owner into the per-wallet rate limiter so the
      // owner is unconditionally allowed. If resolution failed (null), the
      // limiter remains in the no-exemption state — fail-closed is correct.
      this.walletLimiter.setOwnerExempt(this.ownerWallet);
      if (this.ownerWallet) {
        console.log(`Agent owner: ${this.ownerWallet}`);
      } else if (config.AGENT_MODE === 'autonomous') {
        // Config validation prevents reaching here without BOOTSTRAP_WALLET, so
        // a null owner means the on-chain fetch failed (transient RPC).
        console.warn(
          'WARNING: Owner could not be resolved from the on-chain asset. ' +
          'Authorization will fail until resolution succeeds.',
        );
      } else if (config.AGENT_MODE === 'public' && !config.AGENT_ASSET_ADDRESS) {
        console.log(
          'Hint: set BOOTSTRAP_WALLET in .env (or register the agent) to enable owner-gated tools',
        );
      }

      this.resolveReady();
    });
  }

  /**
   * Gracefully shut down: close all sessions, clear intervals, close servers.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.nonceSweepInterval) {
      clearInterval(this.nonceSweepInterval);
      this.nonceSweepInterval = null;
    }

    this.allowlistFile.stop();

    for (const [ws, session] of this.sessions) {
      session.cleanup('Server shutting down');
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1001, 'Server shutting down');
      }
    }
    this.sessions.clear();

    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });

    await new Promise<void>((resolve) => {
      if (!this.httpServer) return resolve();
      this.httpServer.close(() => resolve());
    });
  }

  /**
   * Handle a new WebSocket connection. Sets up handlers, sends the SIWS
   * auth challenge, and arms the handshake timeout. The session stays
   * `unauthenticated` until a valid `auth_response` arrives.
   */
  private handleConnection(ws: WebSocket): void {
    const config = getConfig();

    // --- Connection limit ---
    if (this.sessions.size >= config.MAX_CONNECTIONS) {
      ws.close(4002, 'Too many connections');
      return;
    }

    // --- Create session ---
    const session = new Session(ws, new RateLimiter(20, 10000));
    this.sessions.set(ws, session);

    // H8: both close and error funnel through the same idempotent cleanup.
    // In the error branch we also call terminate() because ws can emit
    // 'error' without a subsequent 'close' in some socket-level failures.
    ws.on('close', () => {
      this.cleanupSession(ws, 'Client disconnected');
    });

    ws.on('error', (err) => {
      console.error('WebSocket client error:', err.message);
      this.cleanupSession(ws, 'Client error');
      try {
        ws.terminate();
      } catch {
        /* ignore — already closed */
      }
    });

    // Terminate connection if pong not received within 60s
    let isAlive = true;
    ws.on('pong', () => { isAlive = true; });
    session.aliveCheck = setInterval(() => {
      if (!isAlive) {
        if (session.aliveCheck) clearInterval(session.aliveCheck);
        session.aliveCheck = null;
        ws.terminate();
        return;
      }
      isAlive = false;
    }, 60000);

    // --- Message handler (registered BEFORE sending the challenge so any
    //     speculative pre-challenge client message is buffered, not dropped) ---
    ws.on('message', (data: RawData) => {
      this.handleMessage(session, data);
    });

    // --- Send connected message ---
    session.send({ type: 'connected', jid: `web:${session.id}` });

    // --- Issue SIWS auth challenge ---
    const issued = this.nonceStore.issue();
    session.pendingNonce = issued.nonce;
    // Prefer the explicit SOLANA_NETWORK override; fall back to URL substring
    // matching for the common case (api.devnet.solana.com / mainnet-beta.solana.com).
    // Custom RPC providers should set SOLANA_NETWORK explicitly to avoid
    // misclassification (e.g. an endpoint whose hostname contains neither token).
    const network: 'solana-mainnet' | 'solana-devnet' =
      config.SOLANA_NETWORK ?? (config.SOLANA_RPC_URL.includes('devnet') ? 'solana-devnet' : 'solana-mainnet');
    // Snapshot the canonical-message inputs so we can rebuild the exact bytes
    // the wallet was asked to sign during auth_response verification. Storing
    // a per-session copy means the comparison is immune to mid-flight config
    // changes (asset address, assistant name, etc).
    const challengeSnapshot: SiwsParams = {
      agentName: config.ASSISTANT_NAME,
      agentAsset: config.AGENT_ASSET_ADDRESS ?? null,
      network,
      nonce: issued.nonce,
      issuedAt: issued.issuedAt,
      expiresAt: issued.expiresAt,
    };
    session.pendingChallenge = challengeSnapshot;
    const challenge: ServerAuthChallenge = {
      type: 'auth_challenge',
      nonce: issued.nonce,
      issuedAt: issued.issuedAt,
      expiresAt: issued.expiresAt,
      agentName: challengeSnapshot.agentName,
      agentAsset: challengeSnapshot.agentAsset,
      network,
      // AGENT_AUTH_MODE is always populated after getConfig()'s post-parse
      // resolution — the schema marks it optional only because the env-var
      // form is optional (auto-resolved from AGENT_MODE + WALLET_ALLOWLIST).
      authMode: config.AGENT_AUTH_MODE!,
    };
    session.send(challenge);

    session.authTimeout = setTimeout(() => {
      if (session.authStatus !== 'authenticated') {
        this.sendAuthError(session, 'auth_timeout', 'Did not authenticate in time.');
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(4001, 'auth_timeout');
        }
      }
    }, config.AUTH_HANDSHAKE_TIMEOUT_MS);
  }

  /**
   * L6 auth-failure telemetry. Emits a console.warn line for any failed
   * authentication attempt: token mismatch, origin rejection, autonomous
   * gate denial, or rate-limit breach. Gated by LOG_AUTH_FAILURES (default
   * true) so operators can silence in noisy dev environments.
   */
  private logAuthFailure(reason: string, meta: Record<string, unknown> = {}): void {
    try {
      const cfg = getConfig();
      if (!cfg.LOG_AUTH_FAILURES) return;
    } catch {
      // If config can't load (e.g. during a startup failure), fall through
      // and log anyway — safety trumps silence.
    }
    const payload = {
      at: 'plexchat',
      event: 'auth_failure',
      reason,
      ts: new Date().toISOString(),
      ...meta,
    };
    console.warn('[auth-failure]', JSON.stringify(payload));
  }

  /**
   * Idempotent per-session cleanup (H8). Called from both ws.on('close')
   * and ws.on('error'). Safe to invoke multiple times.
   */
  private cleanupSession(ws: WebSocket, reason: string): void {
    const session = this.sessions.get(ws);
    if (!session) return;
    session.cleanup(reason);
    this.sessions.delete(ws);
    // Re-emit context to remaining AUTHENTICATED sessions so their
    // connectedClients count updates. Pre-auth peers don't get debug:context
    // (would leak agent metadata + tool list to unauthenticated clients).
    for (const other of this.sessions.values()) {
      if (other.authStatus === 'authenticated') {
        this.emitContext(other);
      }
    }
  }

  /**
   * Handle an incoming WebSocket message.
   */
  private async handleMessage(session: Session, data: RawData): Promise<void> {
    // --- Pre-auth gate: only auth_response is accepted ---
    // We parse first (before the rate limiter) so that pre-auth messages
    // don't count against the post-auth budget. This is intentional: the
    // SIWS handshake is a fixed cost capped by AUTH_HANDSHAKE_TIMEOUT_MS,
    // not a per-message rate.
    if (session.authStatus === 'unauthenticated') {
      let parsed: ClientMessage;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return this.failAuth(session, 'message_mismatch', 'Invalid JSON during auth.');
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        (parsed as { type?: unknown }).type !== 'auth_response'
      ) {
        return this.failAuth(session, 'not_authorized', 'auth_response expected.');
      }
      // Wrap in try/catch so a transient resolveOwner RPC failure (or any
      // unexpected throw) becomes a clean auth_error + close instead of an
      // unhandled rejection that takes down the process.
      try {
        await this.handleAuthResponse(session, parsed as ClientAuthResponse);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.failAuth(session, 'not_authorized', `Internal error during auth: ${detail.slice(0, 120)}`);
      }
      return;
    }

    // Per-wallet rate limit (post-auth, BEFORE per-session). Aggregates across
    // all of a wallet's concurrent sessions, so opening N parallel sockets
    // doesn't multiply the effective budget.
    if (session.walletAddress && !this.walletLimiter.allow(session.walletAddress)) {
      this.logAuthFailure('wallet_rate_limit', {
        sessionId: session.id,
        wallet: session.walletAddress,
      });
      session.send({
        type: 'error',
        error: 'Per-wallet rate limit exceeded.',
        code: 'RATE_LIMIT',
      });
      return;
    }

    // Per-session rate limit (post-auth only). Catches burst behavior on a
    // single connection even when the wallet's aggregate budget is fine.
    if (!session.rateLimiter.allow()) {
      this.logAuthFailure('rate_limit', { sessionId: session.id });
      session.send({ type: 'error', error: 'Rate limit exceeded. Please slow down.', code: 'RATE_LIMIT' });
      return;
    }

    // --- Parse JSON ---
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      session.send({ type: 'error', error: 'Invalid JSON', code: 'INVALID_JSON' });
      return;
    }

    // Basic shape check (defensive — clients might be wrong)
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
      session.send({ type: 'error', error: 'Message missing type', code: 'INVALID_SHAPE' });
      return;
    }

    switch (msg.type) {
      case 'message':
        if (typeof msg.content !== 'string') {
          session.send({ type: 'error', error: 'message.content must be a string', code: 'INVALID_SHAPE' });
          return;
        }
        if (session.isProcessing) {
          session.pendingMessages.push({ content: msg.content, senderName: msg.sender_name });
        } else {
          await this.handleChatMessage(session, msg.content, msg.sender_name);
        }
        break;
      case 'tx_result':
        this.handleTxResult(session, msg.correlationId, msg.signature);
        break;
      case 'tx_error':
        this.handleTxError(session, msg.correlationId, msg.reason);
        break;
      case 'allowlist_list':
        await this.handleAllowlistList(session);
        break;
      case 'allowlist_add':
        await this.handleAllowlistMutate(session, 'add', msg.pubkey);
        break;
      case 'allowlist_remove':
        await this.handleAllowlistMutate(session, 'remove', msg.pubkey);
        break;
      default: {
        // Truncate the echoed type to avoid attacker-controlled-length log spam
        const raw = (msg as { type?: string }).type ?? '';
        const safeType = String(raw).replace(/[^\w.:\-]/g, '').slice(0, 32);
        session.send({
          type: 'error',
          error: `Unknown message type: ${safeType}`,
          code: 'UNKNOWN_TYPE',
        });
      }
    }
  }

  /**
   * Verify an `auth_response`: validate input shape, consume the pending
   * nonce, verify the SIWS signature, run the auth-tier check, and promote
   * the session to `authenticated`. Any failure path closes the socket
   * with code 4001 via `failAuth`.
   */
  private async handleAuthResponse(session: Session, msg: ClientAuthResponse): Promise<void> {
    const config = getConfig();

    // Defensive shape validation — TS says this is a ClientAuthResponse, but
    // the data was just JSON.parsed from an attacker-controlled string.
    // Disarm the handshake timeout the moment we observe an auth_response.
    // Async verification work (resolveOwner RPC, signature verify) can take
    // longer than AUTH_HANDSHAKE_TIMEOUT_MS on a slow network, and we don't
    // want a slow but valid handshake to be racing the timer. Verification
    // outcomes (success or failAuth) take over from here.
    if (session.authTimeout) {
      clearTimeout(session.authTimeout);
      session.authTimeout = null;
    }

    if (
      typeof msg.publicKey !== 'string' ||
      typeof msg.signature !== 'string' ||
      typeof msg.message !== 'string' ||
      !BASE58_ADDRESS_RE.test(msg.publicKey) ||
      !BASE58_SIGNATURE_RE.test(msg.signature)
    ) {
      return this.failAuth(session, 'message_mismatch', 'auth_response fields invalid.');
    }

    // Consume the pending nonce. Single-use, ttl-bounded; consume-before-verify
    // is the replay defense (a replayed valid signature with a consumed nonce
    // fails on consume rather than reaching the crypto path).
    if (!session.pendingNonce) {
      return this.failAuth(session, 'nonce_invalid', 'No pending nonce.');
    }
    const consumedNonce = session.pendingNonce;
    const consumedChallenge = session.pendingChallenge;
    session.pendingNonce = null;
    session.pendingChallenge = null;
    const consumeResult = this.nonceStore.consume(consumedNonce);
    if (!consumeResult.ok) {
      return this.failAuth(session, consumeResult.reason, 'Nonce rejected.');
    }
    if (!consumedChallenge) {
      // Defensive: pendingNonce was set but pendingChallenge wasn't. Should
      // never happen — both are populated together in handleConnection.
      return this.failAuth(session, 'nonce_invalid', 'Missing challenge metadata.');
    }

    // Reconstruct the exact bytes the wallet was supposed to sign and require
    // byte-for-byte equality. This binds the signature to the agent identity
    // and network the wallet displayed in its signing prompt — a malicious
    // client cannot smuggle an agent-substituted or chain-substituted payload
    // past the verifier even when the nonce string is present in the message.
    const canonical = buildSiwsMessage(consumedChallenge);
    if (msg.message !== canonical) {
      return this.failAuth(session, 'message_mismatch', 'Signed message does not match canonical form.');
    }

    // Verify the Ed25519 signature.
    if (!verifySiwsSignature({
      message: msg.message,
      signatureBase58: msg.signature,
      publicKeyBase58: msg.publicKey,
    })) {
      return this.failAuth(session, 'signature_invalid', 'Bad signature.');
    }

    // Auth-tier check. Owner is always authorized regardless of tier.
    const owner = await resolveOwner(config.AGENT_ASSET_ADDRESS ?? null);
    const allowed = isAuthorized({
      // AGENT_AUTH_MODE is always populated after getConfig()'s post-parse
      // resolution; see the comment in handleConnection for context.
      mode: config.AGENT_AUTH_MODE!,
      publicKey: msg.publicKey,
      owner,
      allowlist: this.allowlistFile.current(),
    });
    if (!allowed) {
      return this.failAuth(session, 'not_authorized', 'Wallet not authorized for this agent.');
    }

    // Promote session to authenticated state.
    session.authStatus = 'authenticated';
    session.walletAddress = msg.publicKey;
    session.isOwnerVerified = owner !== null && msg.publicKey === owner;
    // Owner can change at runtime (post-registration, ownership transfer).
    // Keep the per-wallet limiter's exemption in sync with the resolver so a
    // freshly-recognized owner doesn't get rate-limited despite isOwner=true.
    if (owner !== this.ownerWallet) {
      this.ownerWallet = owner;
      this.walletLimiter.setOwnerExempt(owner);
    }

    session.send({
      type: 'authenticated',
      walletAddress: msg.publicKey,
      isOwner: session.isOwnerVerified,
      sessionId: session.id,
    });
    this.emitContext(session);
  }

  /**
   * Send an `auth_error` and close the socket with code 4001. Logs the
   * failure for observability. Use `sendAuthError` directly if you need
   * to send an error without closing.
   */
  private failAuth(session: Session, code: ServerAuthError['code'], message: string): void {
    this.sendAuthError(session, code, message);
    this.logAuthFailure('siws_' + code, { sessionId: session.id });
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.close(4001, code);
    }
  }

  private sendAuthError(session: Session, code: ServerAuthError['code'], message: string): void {
    session.send({ type: 'auth_error', code, message });
  }

  /**
   * Route tx_result to the matching pending transaction promise.
   * Drops unknown correlationIds with an error event (defense-in-depth vs. forged
   * signatures).
   */
  private handleTxResult(session: Session, correlationId: string | undefined, signature: string | undefined): void {
    const config = getConfig();

    if (config.AGENT_MODE === 'autonomous') {
      session.send({ type: 'error', error: 'tx_result is not accepted in autonomous mode', code: 'INVALID_MODE' });
      return;
    }

    if (typeof correlationId !== 'string' || !correlationId) {
      session.send({ type: 'error', error: 'tx_result.correlationId is required', code: 'MISSING_CORRELATION' });
      return;
    }

    if (typeof signature !== 'string' || !BASE58_SIGNATURE_RE.test(signature)) {
      session.send({ type: 'error', error: 'tx_result.signature must be a base58 signature', code: 'INVALID_SIGNATURE' });
      return;
    }

    const pending = session.pendingTransactions.get(correlationId);
    if (!pending) {
      // M10: Unknown correlationId AND a well-formed base58 signature is the
      // "late-ok" case — the user approved the tx after the pending promise
      // already timed out (the tool has already thrown TIMEOUT). The tx did
      // land on-chain, so drop silently to avoid a scary client-side error.
      // We only emit the UNKNOWN_CORRELATION error if the signature itself
      // is malformed (i.e. forged / buggy client).
      if (BASE58_SIGNATURE_RE.test(signature)) {
        console.log(
          `[late-ok] received tx_result for expired correlationId=${correlationId} signature=${signature}`,
        );
        return;
      }
      session.send({ type: 'error', error: 'Unknown correlationId', code: 'UNKNOWN_CORRELATION' });
      return;
    }

    clearTimeout(pending.timeout);
    session.pendingTransactions.delete(correlationId);
    pending.resolve(signature);
  }

  /**
   * Route tx_error to the matching pending transaction promise (rejects it).
   * The reason is sanitized against a safe-character regex to prevent prompt
   * injection when the error bubbles through the agent.
   */
  private handleTxError(session: Session, correlationId: string | undefined, reason: string | undefined): void {
    const config = getConfig();

    if (config.AGENT_MODE === 'autonomous') {
      session.send({ type: 'error', error: 'tx_error is not accepted in autonomous mode', code: 'INVALID_MODE' });
      return;
    }

    if (typeof correlationId !== 'string' || !correlationId) {
      session.send({ type: 'error', error: 'tx_error.correlationId is required', code: 'MISSING_CORRELATION' });
      return;
    }

    const safeReason = typeof reason === 'string' && SAFE_REASON_RE.test(reason)
      ? reason
      : 'User rejected or wallet error';

    const pending = session.pendingTransactions.get(correlationId);
    if (!pending) {
      session.send({ type: 'error', error: 'Unknown correlationId', code: 'UNKNOWN_CORRELATION' });
      return;
    }

    clearTimeout(pending.timeout);
    session.pendingTransactions.delete(correlationId);
    pending.reject(new Error(safeReason));
  }

  /**
   * Handle a chat message: invoke the Mastra agent via streaming and emit
   * debug events over WebSocket as stream chunks arrive.
   */
  private async handleChatMessage(
    session: Session,
    content: string | undefined,
    _senderName?: string,
  ): Promise<void> {
    if (!content) {
      session.send({
        type: 'error',
        error: 'Expected { type: "message", content: "..." }',
        code: 'INVALID_SHAPE',
      });
      return;
    }

    if (!content.trim()) return;

    const config = getConfig();

    // M3: per-message content cap. The transport-level maxPayload is 64 KB,
    // but we want to reject multi-KB prose *before* it enters history and
    // inflates LLM cost forever.
    if (content.length > config.MAX_MESSAGE_CONTENT) {
      session.send({
        type: 'error',
        error:
          `Message exceeds maximum length of ${config.MAX_MESSAGE_CONTENT} characters ` +
          `(got ${content.length}).`,
        code: 'MESSAGE_TOO_LARGE',
      });
      return;
    }

    session.isProcessing = true;
    session.currentAbortController = new AbortController();
    session.send({ type: 'typing', isTyping: true });

    // M5: cumulative wall-clock RPC budget. If the agent's streaming call
    // (including all tool roundtrips) exceeds MAX_RPC_TIME_BUDGET_MS, we
    // abort the controller so tools (including sleep via abortSignal in
    // RequestContext) unwind promptly.
    let budgetTimer: ReturnType<typeof setTimeout> | null = null;
    let budgetTripped = false;

    try {
      const transactionSender: TransactionSender = {
        sendAndAwait: (txBase64, options) =>
          this.awaitTransaction(session, txBase64, options),
      };

      // We build RequestContext with the AgentContext keys plus an extra
      // `abortSignal` entry (Workstream B's sleep tool reads it). The
      // AgentContext-typed generic enforces a fixed key set, so we widen
      // the generic to AgentContext plus the extra key. Tools that read it
      // can cast back to AgentContext where convenient.
      type ExtendedContext = AgentContext & { abortSignal: AbortSignal };
      const requestContext = new RequestContext<ExtendedContext>([
        ['walletAddress', session.walletAddress],
        ['transactionSender', transactionSender],
        ['agentMode', config.AGENT_MODE],
        ['agentAssetAddress', config.AGENT_ASSET_ADDRESS ?? null],
        ['agentTokenMint', config.AGENT_TOKEN_MINT ?? null],
        ['agentFeeSol', config.AGENT_FEE_SOL],
        ['tokenOverride', config.TOKEN_OVERRIDE ?? null],
        ['ownerWallet', this.ownerWallet],
        ['abortSignal', session.currentAbortController.signal],
      ]);

      // C1: sanitize both the agent status label and the user wallet before
      // interpolating into the `[Agent: … | User wallet: X]` prefix. Previously
      // a crafted base58 wallet could close the bracket and inject a fake
      // system directive into every subsequent turn.
      const sanitizedContent = content.replace(/[\r\n\[\]]/g, ' ');
      const keypairAddr = getAgentKeypairPublicKey();
      const pdaAddr = config.AGENT_ASSET_ADDRESS
        ? getAgentPda(createUmi(), publicKey(config.AGENT_ASSET_ADDRESS)).toString()
        : null;
      const rawStatus = config.AGENT_ASSET_ADDRESS
        ? `Agent: registered | Asset: ${config.AGENT_ASSET_ADDRESS} | Keypair: ${keypairAddr} | PDA: ${pdaAddr}`
        : `Agent: not registered | Keypair: ${keypairAddr}`;
      const agentStatus = sanitizeForPrefix(rawStatus);
      const walletStatus = session.walletAddress
        ? ` | User wallet: ${sanitizeForPrefix(session.walletAddress)}`
        : '';
      const fullMessage = `[${agentStatus}${walletStatus}] ${sanitizedContent}`;

      session.conversationHistory.push({ role: 'user', content: fullMessage });
      this.capHistory(session);

      const startTime = Date.now();

      // M5: arm the wall-clock budget timer. The agent is expected to
      // complete within MAX_RPC_TIME_BUDGET_MS; otherwise we abort the
      // controller, which (a) cancels the stream reader and (b) notifies
      // the sleep tool (which reads abortSignal from the request context).
      budgetTimer = setTimeout(() => {
        budgetTripped = true;
        session.currentAbortController?.abort();
      }, config.MAX_RPC_TIME_BUDGET_MS);

      const stream = await this.agent.stream(session.conversationHistory, {
        requestContext: requestContext as any,
        maxSteps: config.MAX_STEPS,
        abortSignal: session.currentAbortController.signal,
      });

      let currentStep = 0;
      let stepStartTime = Date.now();
      const debugEnabled = config.ENABLE_DEBUG_EVENTS;

      // --- Budget tracking (M10) ---
      const limits = getServerLimits();
      let cumulativeTokens = 0;
      let toolExecutionCount = 0;
      let budgetExceededReason: string | null = null;

      const reader = stream.fullStream.getReader();
      try {
        while (true) {
          // Check if aborted
          if (session.currentAbortController?.signal.aborted) {
            await reader.cancel().catch(() => { /* ignore */ });
            break;
          }

          const { done, value: chunk } = await reader.read();
          if (done) break;

          switch (chunk.type) {
            case 'step-start':
              currentStep++;
              stepStartTime = Date.now();
              if (debugEnabled) {
                session.send({
                  type: 'debug:step_start',
                  step: currentStep,
                  stepType: currentStep === 1 ? 'initial' : 'tool-result',
                });
              }
              break;

            case 'tool-call':
              toolExecutionCount++;
              if (toolExecutionCount > limits.MAX_TOOL_EXECUTIONS_PER_MESSAGE) {
                budgetExceededReason =
                  `tool-execution limit of ${limits.MAX_TOOL_EXECUTIONS_PER_MESSAGE} ` +
                  `(${toolExecutionCount} used)`;
              }
              if (debugEnabled) {
                session.send({
                  type: 'debug:tool_call',
                  step: currentStep,
                  toolCallId: chunk.payload.toolCallId,
                  toolName: chunk.payload.toolName,
                  args: (chunk.payload.args as Record<string, unknown>) ?? {},
                });
              }
              break;

            case 'tool-result':
              if (debugEnabled) {
                session.send({
                  type: 'debug:tool_result',
                  step: currentStep,
                  toolCallId: chunk.payload.toolCallId,
                  toolName: chunk.payload.toolName,
                  result: chunk.payload.result,
                  isError: chunk.payload.isError ?? false,
                  durationMs: Date.now() - stepStartTime,
                });
              }
              break;

            case 'text-delta':
              if (debugEnabled) {
                session.send({
                  type: 'debug:text_delta',
                  step: currentStep,
                  delta: chunk.payload.text,
                });
              }
              break;

            case 'step-finish': {
              const stepInput = chunk.payload.output?.usage?.inputTokens ?? 0;
              const stepOutput = chunk.payload.output?.usage?.outputTokens ?? 0;
              cumulativeTokens += stepInput + stepOutput;
              if (cumulativeTokens > limits.MAX_TOKENS_PER_MESSAGE && !budgetExceededReason) {
                budgetExceededReason =
                  `token limit of ${limits.MAX_TOKENS_PER_MESSAGE} ` +
                  `(${cumulativeTokens} used)`;
              }
              if (debugEnabled) {
                session.send({
                  type: 'debug:step_complete',
                  step: currentStep,
                  finishReason: chunk.payload.stepResult?.reason ?? 'unknown',
                  usage: {
                    inputTokens: stepInput,
                    outputTokens: stepOutput,
                    reasoningTokens: chunk.payload.output?.usage?.reasoningTokens,
                    cachedInputTokens: chunk.payload.output?.usage?.cachedInputTokens,
                  },
                  durationMs: Date.now() - stepStartTime,
                });
              }
              stepStartTime = Date.now();
              break;
            }
          }

          // If a budget was exceeded, abort the stream and stop reading.
          if (budgetExceededReason) {
            session.currentAbortController?.abort();
            await reader.cancel().catch(() => { /* ignore */ });
            break;
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Surface budget breach as an error + informational message to the user.
      if (budgetExceededReason) {
        session.send({
          type: 'error',
          error: `Exceeded ${budgetExceededReason}`,
          code: 'BUDGET_EXCEEDED',
        });
        const userMsg =
          `Stopped: exceeded the ${budgetExceededReason} limit. This is a safety cap.`;
        session.conversationHistory.push({ role: 'assistant', content: userMsg });
        this.capHistory(session);
        session.send({
          type: 'message',
          content: userMsg,
          sender: config.ASSISTANT_NAME,
        });
        if (debugEnabled) {
          session.send({
            type: 'debug:generation_complete',
            totalSteps: currentStep,
            totalUsage: { inputTokens: 0, outputTokens: cumulativeTokens },
            totalDurationMs: Date.now() - startTime,
            finishReason: 'budget_exceeded',
          });
        }
        this.emitContext(session);
        return;
      }

      // If aborted, don't await the stream promises (they'll hang).
      if (session.currentAbortController?.signal.aborted) {
        // M5: if the wall-clock budget tripped the abort (as opposed to a
        // client disconnect or a budget-exceeded path above), surface it
        // explicitly to the client so they know what happened.
        if (budgetTripped) {
          session.send({
            type: 'error',
            error:
              `Exceeded RPC time budget of ${config.MAX_RPC_TIME_BUDGET_MS}ms. ` +
              'Aborted for safety.',
            code: 'BUDGET_EXCEEDED',
          });
          const userMsg =
            `Stopped: this turn exceeded the ${config.MAX_RPC_TIME_BUDGET_MS}ms RPC time budget.`;
          session.conversationHistory.push({ role: 'assistant', content: userMsg });
          this.capHistory(session);
          session.send({
            type: 'message',
            content: userMsg,
            sender: config.ASSISTANT_NAME,
          });
          if (debugEnabled) {
            session.send({
              type: 'debug:generation_complete',
              totalSteps: currentStep,
              totalUsage: { inputTokens: 0, outputTokens: cumulativeTokens },
              totalDurationMs: Date.now() - startTime,
              finishReason: 'budget_exceeded',
            });
          }
          this.emitContext(session);
        }
        return;
      }

      const text = await stream.text;
      const totalUsage = await stream.totalUsage;

      session.conversationHistory.push({ role: 'assistant', content: text });
      this.capHistory(session);

      if (debugEnabled) {
        session.send({
          type: 'debug:generation_complete',
          totalSteps: currentStep,
          totalUsage: {
            inputTokens: totalUsage?.inputTokens ?? 0,
            outputTokens: totalUsage?.outputTokens ?? 0,
            reasoningTokens: totalUsage?.reasoningTokens,
            cachedInputTokens: totalUsage?.cachedInputTokens,
          },
          totalDurationMs: Date.now() - startTime,
          finishReason: (await stream.finishReason) ?? 'unknown',
        });
      }

      session.send({
        type: 'message',
        content: text,
        sender: config.ASSISTANT_NAME,
      });

      this.emitContext(session);
    } catch (error) {
      const errName = error instanceof Error ? error.name : '';
      const errorMsg = error instanceof Error ? error.message : 'An unknown error occurred';

      // AbortError = clean shutdown; don't surface an error to the user.
      if (errName !== 'AbortError') {
        console.error('Agent stream error:', errorMsg);
        const errorContent = 'I encountered an error processing your request. Please try again.';
        session.conversationHistory.push({ role: 'assistant', content: errorContent });
        this.capHistory(session);
        session.send({
          type: 'message',
          content: errorContent,
          sender: config.ASSISTANT_NAME,
        });
      }

      // Emit a synthetic generation_complete so the debug panel doesn't stay pending.
      if (config.ENABLE_DEBUG_EVENTS) {
        session.send({
          type: 'debug:generation_complete',
          totalSteps: 0,
          totalUsage: { inputTokens: 0, outputTokens: 0 },
          totalDurationMs: 0,
          finishReason: errName === 'AbortError' ? 'aborted' : 'error',
        });
      }
      this.emitContext(session);
    } finally {
      // M5: always clear the budget timer; otherwise a short turn would
      // still fire the abort() 60s later and zombie-abort whatever comes next.
      if (budgetTimer) {
        clearTimeout(budgetTimer);
        budgetTimer = null;
      }
      session.send({ type: 'typing', isTyping: false });
      session.isProcessing = false;
      session.currentAbortController = null;

      // Drain pending chat messages that arrived while we were busy.
      while (session.pendingMessages.length > 0 && !this.stopped) {
        const next = session.pendingMessages.shift()!;
        await this.handleChatMessage(session, next.content, next.senderName);
      }
    }
  }

  /**
   * Send a transaction to the session's client and await the user's signed signature.
   * Resolves with the base58 signature; rejects on user reject, timeout, or disconnect.
   */
  private awaitTransaction(
    session: Session,
    transactionBase64: string,
    options?: { message?: string; index?: number; total?: number; feeSol?: number },
  ): Promise<string> {
    const correlationId = randomUUID();

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        session.pendingTransactions.delete(correlationId);
        reject(new Error('Transaction approval timed out'));
      }, TX_APPROVAL_TIMEOUT_MS);

      session.pendingTransactions.set(correlationId, { resolve, reject, timeout });

      session.send({
        type: 'transaction',
        transaction: transactionBase64,
        correlationId,
        message: options?.message,
        index: options?.index,
        total: options?.total,
        feeSol: options?.feeSol,
      });
    });
  }

  /**
   * Owner-only: send the current allowlist snapshot to the requesting
   * session. Non-owner senders get an `allowlist_error: not_authorized`.
   *
   * The snapshot includes the env-supplied wallets too, so the UI can
   * display them as "read-only" rows alongside the file-managed entries.
   * We deliberately do NOT include the on-chain owner in the wallets
   * array — the owner is implicitly always allowed regardless, and adding
   * it to the user-visible list invites a confusing "remove the owner?"
   * UX path that does nothing.
   */
  private async handleAllowlistList(session: Session): Promise<void> {
    if (!(await this.requireOwner(session))) return;
    this.sendAllowlistState(session);
  }

  /**
   * Owner-only: add or remove a base58 pubkey from the allowlist file.
   * On success, broadcasts the new snapshot to the requesting session.
   * Validation errors and write failures map to coded `allowlist_error`
   * messages — the UI surfaces them inline next to the input.
   */
  private async handleAllowlistMutate(
    session: Session,
    op: 'add' | 'remove',
    rawPubkey: unknown,
  ): Promise<void> {
    if (!(await this.requireOwner(session))) return;
    const config = getConfig();
    if (config.AGENT_AUTH_MODE !== 'allowlist') {
      session.send({
        type: 'allowlist_error',
        code: 'wrong_auth_mode',
        message:
          `Agent is in '${config.AGENT_AUTH_MODE}' mode — the allowlist is only ` +
          'consulted in `allowlist` mode. Set AGENT_AUTH_MODE=allowlist (or add ' +
          'WALLET_ALLOWLIST entries) and restart to enable list management.',
      });
      return;
    }
    if (typeof rawPubkey !== 'string' || !BASE58_ADDRESS_RE.test(rawPubkey)) {
      session.send({
        type: 'allowlist_error',
        code: 'bad_pubkey',
        message: 'pubkey must be a valid base58 32-byte Solana address',
      });
      return;
    }
    // Regex matches base58-shaped strings of length 32-44, but a 32-char
    // base58 string only decodes to ~23 bytes — not a valid Solana pubkey.
    // umi's `publicKey()` parses + validates length, so use it as the
    // canonical 32-byte check before persisting to the allowlist file.
    let normalizedPubkey: string;
    try {
      normalizedPubkey = publicKey(rawPubkey).toString();
    } catch (err) {
      session.send({
        type: 'allowlist_error',
        code: 'bad_pubkey',
        message: 'pubkey must decode to a 32-byte Solana public key',
      });
      return;
    }
    if (op === 'remove' && this.allowlistFile.envWallets.includes(normalizedPubkey)) {
      // Tell the operator the entry is sourced from env so they don't think
      // the remove silently failed.
      session.send({
        type: 'allowlist_error',
        code: 'env_only',
        message:
          `Wallet ${rawPubkey} is in WALLET_ALLOWLIST (env). Remove it from the ` +
          'env var and restart the server — the file admin cannot manage env-supplied entries.',
      });
      return;
    }
    try {
      if (op === 'add') {
        this.allowlistFile.addWallet(normalizedPubkey);
      } else {
        this.allowlistFile.removeWallet(normalizedPubkey);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error('[allowlist-admin] file write failed:', detail);
      session.send({
        type: 'allowlist_error',
        code: 'file_write_failed',
        message: 'Failed to update the allowlist file. Check server logs and file permissions.',
      });
      return;
    }
    this.sendAllowlistState(session);
  }

  /**
   * Gate an admin request on live on-chain ownership.
   *
   * `session.isOwnerVerified` reflects the owner at the time of SIWS
   * handshake — a long-lived session could otherwise keep admin rights
   * after an on-chain ownership transfer. Re-resolving each call (with
   * the existing `resolveOwner` TTL cache) makes the check honor the
   * current owner. Resolver errors fail closed.
   */
  private async requireOwner(session: Session): Promise<boolean> {
    if (session.authStatus !== 'authenticated' || !session.walletAddress) {
      this.logAuthFailure('allowlist_admin_not_authenticated', {
        sessionId: session.id,
        wallet: session.walletAddress,
      });
      session.send({
        type: 'allowlist_error',
        code: 'not_authorized',
        message: 'Allowlist admin requires the on-chain owner wallet.',
      });
      return false;
    }
    const config = getConfig();
    let currentOwner: string | null;
    try {
      currentOwner = await resolveOwner(config.AGENT_ASSET_ADDRESS ?? null);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logAuthFailure('allowlist_admin_owner_resolve_failed', {
        sessionId: session.id,
        wallet: session.walletAddress,
        detail,
      });
      session.send({
        type: 'allowlist_error',
        code: 'not_authorized',
        message: 'Could not verify current on-chain owner.',
      });
      return false;
    }
    if (currentOwner === null || session.walletAddress !== currentOwner) {
      this.logAuthFailure('allowlist_admin_not_owner', {
        sessionId: session.id,
        wallet: session.walletAddress,
      });
      // Keep the session's cached owner flag in sync with the live owner so
      // emit-context and other consumers don't keep advertising stale state.
      session.isOwnerVerified = false;
      session.send({
        type: 'allowlist_error',
        code: 'not_authorized',
        message: 'Allowlist admin requires the on-chain owner wallet.',
      });
      return false;
    }
    session.isOwnerVerified = true;
    return true;
  }

  /** Build and send a fresh snapshot to a single session. */
  private sendAllowlistState(session: Session): void {
    // Force a reload so an out-of-band edit (e.g. the operator hand-editing
    // the file) is visible to the admin without waiting for the poll cycle.
    this.allowlistFile.reload();
    session.send({
      type: 'allowlist_state',
      wallets: [...this.allowlistFile.fileWallets()],
      filePath: this.allowlistFile.path,
      envWallets: [...this.allowlistFile.envWallets],
    });
  }

  private emitContext(session: Session): void {
    const config = getConfig();
    if (!config.ENABLE_DEBUG_EVENTS) return;
    const tools = config.AGENT_MODE === 'autonomous' ? autonomousToolNames : publicToolNames;
    session.send({
      type: 'debug:context',
      agentMode: config.AGENT_MODE,
      model: config.LLM_MODEL,
      assistantName: config.ASSISTANT_NAME,
      walletAddress: session.walletAddress,
      connectedClients: this.sessions.size,
      conversationLength: session.conversationHistory.length,
      tools,
    });
  }

  private capHistory(session: Session): void {
    if (session.conversationHistory.length > PlexChatServer.MAX_HISTORY) {
      session.conversationHistory = session.conversationHistory.slice(-PlexChatServer.MAX_HISTORY);
    }
  }
}
