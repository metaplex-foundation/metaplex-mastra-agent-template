import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'http';
import { timingSafeEqual, randomUUID } from 'crypto';
import {
  getConfig,
  getServerLimits,
  resolveOwner,
  createUmi,
  type ServerMessage,
  type TransactionSender,
  type AgentContext,
  type ClientMessage,
} from '@metaplex-agent/shared';
import { createAgent, publicToolNames, autonomousToolNames } from '@metaplex-agent/core';
import { RequestContext } from '@mastra/core/request-context';
import { Session, type SimpleRateLimiter } from './session.js';

// Split regexes for different base58 contexts
const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

// Tx approval timeout (5 minutes). Long enough for slow networks / user
// attention lapses; short enough that a forgotten tab doesn't leak forever.
const TX_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

// Sanitizer for user-supplied error reasons — allow safe punctuation, letters, digits, spaces
const SAFE_REASON_RE = /^[\w\s.,:;'"()?!\-]{0,200}$/;

/**
 * Subprotocol name used for the Sec-WebSocket-Protocol auth path (C3).
 * Clients send `['bearer', '<token>']`; server echoes back `'bearer'`.
 */
const BEARER_SUBPROTOCOL = 'bearer';

/**
 * Strip characters that could close / inject into the `[Agent: … | User wallet: X]`
 * prefix the agent sees (C1). Also caps length so an attacker can't pad it
 * into context bloat. 88 chars comfortably holds any valid base58 address.
 */
function sanitizeForPrefix(s: string): string {
  return s.replace(/[\[\]\r\n]/g, '').slice(0, 88);
}

/**
 * Extract the `bearer.<token>` subprotocol token from a Sec-WebSocket-Protocol
 * header (C3). Also accepts the two-element form `['bearer', '<token>']`.
 * Returns null if no bearer token is present.
 */
function extractSubprotocolToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const parts = headerValue.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  // Two-element form: ['bearer', '<token>']
  if (parts.length === 2 && parts[0] === BEARER_SUBPROTOCOL) {
    return parts[1] ?? null;
  }
  // Compact form: 'bearer.<token>'
  for (const p of parts) {
    if (p.startsWith(`${BEARER_SUBPROTOCOL}.`)) {
      const tok = p.slice(BEARER_SUBPROTOCOL.length + 1);
      if (tok.length > 0) return tok;
    }
  }
  return null;
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
  private stopped = false;

  private static readonly MAX_HISTORY = 50;

  constructor() {
    this.agent = createAgent();
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

    this.httpServer = createServer();

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
      // C3: Subprotocol negotiation. If the client requested the `bearer`
      // subprotocol, echo it back so the handshake succeeds. The token is
      // validated in handleConnection, not here. If no subprotocol is sent
      // (query / Authorization header auth paths) the handshake still
      // succeeds — `ws` treats `false` as "no subprotocol agreed upon".
      handleProtocols: (protocols: Set<string>) => {
        if (protocols.has(BEARER_SUBPROTOCOL)) return BEARER_SUBPROTOCOL;
        return false;
      },
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
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

    this.httpServer.listen(port, async () => {
      console.log(`PlexChat WebSocket server running on ws://localhost:${port}`);
      console.log(`Agent mode: ${config.AGENT_MODE}`);
      console.log(`Agent name: ${config.ASSISTANT_NAME}`);
      console.log(`RPC: ${config.SOLANA_RPC_URL}`);
      console.log('Test UI (if running): http://localhost:3001');

      // Resolve owner at startup
      this.ownerWallet = await resolveOwner(config.AGENT_ASSET_ADDRESS ?? null);
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
   * Handle a new WebSocket connection. Validates the auth token
   * and sets up message handlers.
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const config = getConfig();

    // --- Authentication (constant-time comparison) ---
    const token = this.extractToken(req);
    if (!this.secureTokenCompare(token, config.WEB_CHANNEL_TOKEN)) {
      this.logAuthFailure('token_mismatch', {
        remote: req.socket.remoteAddress ?? null,
        origin: req.headers.origin ?? null,
        hadToken: token !== null,
      });
      ws.close(4001, 'Unauthorized');
      return;
    }

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

    // --- Send connected message ---
    session.send({ type: 'connected', jid: `web:${session.id}` });
    this.emitContext(session);

    // --- Message handler ---
    ws.on('message', (data: RawData) => {
      this.handleMessage(session, data);
    });
  }

  /**
   * Constant-time token comparison to prevent timing attacks.
   */
  private secureTokenCompare(provided: string | null, expected: string): boolean {
    if (!provided) return false;
    try {
      const a = Buffer.from(provided);
      const b = Buffer.from(expected);
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /**
   * Extract the auth token from the request. Checked in priority order:
   *   1. `Sec-WebSocket-Protocol: bearer, <token>` (C3, preferred; not logged
   *      by most reverse proxies).
   *   2. `Authorization: Bearer <token>` header.
   *   3. `?token=<token>` query parameter (legacy; tokens can leak via
   *      Referer / access logs — deprecated but kept for curl convenience).
   */
  private extractToken(req: IncomingMessage): string | null {
    // C3: Sec-WebSocket-Protocol bearer subprotocol
    const subprotoHeader = req.headers['sec-websocket-protocol'];
    const subprotoToken = extractSubprotocolToken(
      Array.isArray(subprotoHeader) ? subprotoHeader.join(',') : subprotoHeader,
    );
    if (subprotoToken) return subprotoToken;

    // Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    // Legacy query parameter
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const queryToken = url.searchParams.get('token');
    if (queryToken) return queryToken;

    return null;
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
    // Re-emit context to remaining sessions so their connectedClients count updates
    for (const other of this.sessions.values()) {
      this.emitContext(other);
    }
  }

  /**
   * Handle an incoming WebSocket message.
   */
  private async handleMessage(session: Session, data: RawData): Promise<void> {
    // Rate limiting
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

    // --- Autonomous mode connection gate ---
    // Only the asset owner can interact; all other messages are rejected
    // before the LLM is ever invoked. Verification is per-session.
    const config = getConfig();
    if (config.AGENT_MODE === 'autonomous' && msg.type !== 'wallet_connect') {
      if (!session.isOwnerVerified) {
        this.logAuthFailure('autonomous_not_verified', {
          sessionId: session.id,
          msgType: msg.type,
        });
        session.send({
          type: 'error',
          error: 'This agent only accepts commands from its owner. Please connect your wallet first.',
          code: 'NOT_OWNER',
        });
        return;
      }

      // C5: Re-resolve owner on every autonomous turn to close the TOCTOU
      // window. The owner cache makes this effectively O(1); on a genuine
      // on-chain ownership change the stale verification is cleared.
      if (msg.type === 'message') {
        const currentOwner = await resolveOwner(config.AGENT_ASSET_ADDRESS ?? null);
        if (!currentOwner || session.walletAddress !== currentOwner) {
          this.logAuthFailure('autonomous_owner_changed', {
            sessionId: session.id,
            session_wallet: session.walletAddress,
            current_owner: currentOwner,
          });
          session.isOwnerVerified = false;
          this.ownerWallet = currentOwner;
          session.send({
            type: 'error',
            error:
              'Owner verification is stale. The connected wallet is no longer the owner. ' +
              'Please reconnect.',
            code: 'NOT_OWNER',
          });
          return;
        }
      }
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
      case 'wallet_connect':
        await this.handleWalletConnect(session, msg.address);
        break;
      case 'wallet_disconnect':
        this.handleWalletDisconnect(session);
        break;
      case 'tx_result':
        this.handleTxResult(session, msg.correlationId, msg.signature);
        break;
      case 'tx_error':
        this.handleTxError(session, msg.correlationId, msg.reason);
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
      const rawStatus = config.AGENT_ASSET_ADDRESS
        ? `Agent: registered | Asset: ${config.AGENT_ASSET_ADDRESS}`
        : 'Agent: not registered';
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
   * Handle wallet_connect: store address on the session, verify owner in autonomous mode,
   * and send confirmation.
   */
  private async handleWalletConnect(session: Session, address: string | undefined): Promise<void> {
    if (!address?.trim()) {
      session.send({
        type: 'error',
        error: 'wallet_connect requires a non-empty address string',
        code: 'INVALID_ADDRESS',
      });
      return;
    }

    if (!BASE58_ADDRESS_RE.test(address)) {
      session.send({
        type: 'error',
        error: 'Invalid wallet address format',
        code: 'INVALID_ADDRESS',
      });
      return;
    }

    const config = getConfig();

    // Re-resolve owner (asset may have been registered since startup)
    this.ownerWallet = await resolveOwner(config.AGENT_ASSET_ADDRESS ?? null);

    // --- Autonomous mode owner gate ---
    if (config.AGENT_MODE === 'autonomous') {
      if (!this.ownerWallet) {
        session.send({
          type: 'error',
          error: 'No owner could be resolved from the on-chain asset. Authorization is unavailable.',
          code: 'NO_OWNER',
        });
        return;
      }

      if (address !== this.ownerWallet) {
        session.isOwnerVerified = false;
        session.send({
          type: 'error',
          error: 'This agent only accepts commands from its owner. The connected wallet is not the owner.',
          code: 'NOT_OWNER',
        });
        return;
      }

      session.isOwnerVerified = true;
    }

    session.walletAddress = address;
    session.send({ type: 'wallet_connected', address });
    this.emitContext(session);
  }

  /**
   * Handle wallet_disconnect: clear the session's address and verification.
   */
  private handleWalletDisconnect(session: Session): void {
    session.walletAddress = null;
    session.isOwnerVerified = false;
    session.send({ type: 'wallet_disconnected' });
    this.emitContext(session);
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
