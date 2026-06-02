import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  Keypair as Web3Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  createNoopSigner,
  createSignerFromKeypair,
  publicKey as umiPubkey,
  signerIdentity,
  sol,
  transactionBuilder,
  type Keypair as UmiKeypair,
} from '@metaplex-foundation/umi';
import { createUmi as createUmiBase } from '@metaplex-foundation/umi-bundle-defaults';
import { mplToolbox, transferSol } from '@metaplex-foundation/mpl-toolbox';
import { execute, findAssetSignerPda } from '@metaplex-foundation/mpl-core';
import { toWeb3JsTransaction } from '@metaplex-foundation/umi-web3js-adapters';

/** Sentinel value plumber uses in `PaymentRequirements.asset` for native SOL. */
const NATIVE_SOL_ASSET = 'SOL';
/** SPL Memo program — used as a plain memo instruction in both paths. */
const MEMO_PROGRAM_PUBKEY = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

// ---------------------------------------------------------------------------
// Process-wide payment event emitter
// ---------------------------------------------------------------------------

/**
 * Fired whenever a payment-shaped thing happens against plumber from this
 * process. The server's WebSocket session subscribes during a connected
 * session and forwards each event to the chat UI as a `debug:ledger` so
 * an operator can watch fund flows in real time.
 *
 * Events are global (one emitter per process) — subscribers see ALL
 * payment activity, not just their own session. For the single-active-
 * session common case that's fine; for multi-session deployments the
 * UI shows ALL activity which is still a useful debugging view.
 */
export interface PlumberPaymentEvent {
  /**
   * Shape categorization:
   *   - `x402-paid`         — we just paid an x402 invoice
   *   - `x402-rejected`     — the retry came back with another 402 or error
   *   - `delegate-charge`   — settled response carried X-PAYMENT-RESPONSE for delegate-pay rail
   *   - `delegate-onboard`  — we registered ourselves as a delegate of plumber
   */
  kind:
    | 'x402-paid'
    | 'x402-rejected'
    | 'delegate-charge'
    | 'delegate-onboard';
  label: string;
  from?: string | null;
  to?: string | null;
  amount?: string | null;
  unit?: string | null;
  amountDisplay?: string | null;
  signature?: string | null;
  cluster?: 'devnet' | 'mainnet-beta' | 'testnet' | null;
  ts: string;
  detail?: Record<string, unknown> | null;
}

const paymentEvents = new EventEmitter();
// Plenty of headroom — one listener per active WS session, plus internal
// observers (metrics, logs). Default is 10, which would warn on a busy
// process.
paymentEvents.setMaxListeners(50);

/** Subscribe to payment events. Returns an unsubscribe fn. */
export function onPlumberPayment(
  listener: (ev: PlumberPaymentEvent) => void,
): () => void {
  paymentEvents.on('payment', listener);
  return () => paymentEvents.off('payment', listener);
}

/** Internal: emit a payment event. */
function emitPaymentEvent(ev: PlumberPaymentEvent): void {
  try {
    paymentEvents.emit('payment', ev);
  } catch (err) {
    // A misbehaving subscriber should never break the payment flow.
    console.warn('[plumber-client] payment-event listener threw', err);
  }
}

/**
 * x402 v2 client for the agent-plumber HTTP surface.
 *
 * The template uses plumber's OpenAI-compatible endpoints (`/v1/chat/completions`,
 * `/v1/images/generations`) and JSON-RPC passthrough (`/v1/solana/rpc`). Every
 * outgoing request goes through `plumberFetch(client)`:
 *
 *   1. First call hits the endpoint with no payment.
 *   2. Plumber returns HTTP 402 with a canonical `PaymentRequired` body —
 *      including a `feePayer` (plumber's keypair) and a fresh `blockhash`
 *      so we don't need our own Solana RPC.
 *   3. plumberFetch builds a `TransferChecked` USDC partial-signed tx with
 *      compute-budget + memo instructions exactly matching the spec's MUST
 *      checks, base64-encodes it, and retries with `X-PAYMENT`.
 *   4. Plumber acts as facilitator: verifies the partial tx, co-signs as
 *      feePayer, submits, and returns the cached result + an `X-PAYMENT-RESPONSE`
 *      header carrying the on-chain signature.
 *
 * Importantly, the client makes **zero Solana RPC calls**. The agent's
 * keypair only signs locally (using `@solana/web3.js`'s `partialSign`), and
 * the facilitator handles submission. No `SOLANA_RPC_URL` needed in plumber
 * mode.
 */

// ---------------------------------------------------------------------------
// Wire types (mirror plumber's x402.ts)
// ---------------------------------------------------------------------------

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: 2;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: { transaction: string };
  extensions?: Record<string, unknown>;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
  amount?: string;
  extensions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Client config
// ---------------------------------------------------------------------------

export type PaymentSource = 'keypair' | 'pda';

export interface PlumberClientOptions {
  /** Plumber base URL (e.g. `https://plumber.example.com`). */
  baseUrl: string;
  /**
   * Caller's executive keypair (Umi format `{ publicKey, secretKey }`).
   * Signs the partial tx as the transfer `authority` (keypair source) or
   * as the Execute-CPI executive (pda source).
   */
  agentKeypair: UmiKeypair;
  /**
   * Where to fund payments from:
   *   - `'keypair'` (default): the agent's keypair wallet pays directly via
   *     `SystemProgram.transfer` (SOL) or `TransferChecked` (SPL).
   *   - `'pda'`: the agent's mpl-core asset signer PDA pays. The tx wraps
   *     an inner `transferSol` in an `Execute` CPI signed by the executive
   *     keypair. Currently SOL-only — SPL-from-PDA is a follow-up.
   */
  paymentSource?: PaymentSource;
  /**
   * Required when `paymentSource === 'pda'`. The on-chain mpl-core asset
   * whose signer PDA owns the funds we're paying with — typically the
   * template's own `AGENT_ASSET_ADDRESS`.
   */
  agentAssetAddress?: string;
}

/**
 * Auth/payment helper for the plumber HTTP surface.
 *
 * Two rails are supported in parallel:
 *
 *  1. **Delegate-pay (primary)** — when this template has registered plumber
 *     as an execution delegate on its agent asset, plumber can settle each
 *     paid call by Execute-CPI charging the asset's PDA directly. For
 *     plumber to *know* the call is delegated, we have to prove our
 *     identity: handshake at /auth/handshake with the agent keypair,
 *     receive a 15-min bearer, attach `Authorization: Bearer …` on every
 *     subsequent request.
 *
 *  2. **x402 (fallback)** — when no bearer is presented OR the on-chain
 *     delegation check fails OR the Execute CPI fails (e.g. PDA empty),
 *     plumber returns HTTP 402 and we partial-sign a payment tx that
 *     plumber co-signs as feePayer.
 *
 * The handshake is best-effort: if it fails (no agent asset configured,
 * the agent isn't delegated yet, the network is flaky) we just send the
 * request unauthenticated and let plumber answer with a 402 → the x402
 * path takes over.
 */
export class PlumberClient {
  /** web3.js Keypair derived from the Umi keypair, cached. */
  private readonly web3Keypair: Web3Keypair;

  /**
   * Cached bearer token from /auth/handshake. Refreshed lazily on first
   * use and whenever the cached entry is within 30s of expiry or a request
   * comes back 401.
   */
  private _bearer: { token: string; expiresAt: number } | null = null;

  /**
   * In-flight handshake promise, deduplicates concurrent first-call traffic
   * (two requests racing to `/auth/handshake` would burn a nonce slot for
   * no reason).
   */
  private _handshakeInFlight: Promise<string | null> | null = null;

  constructor(private readonly opts: PlumberClientOptions) {
    this.web3Keypair = Web3Keypair.fromSecretKey(opts.agentKeypair.secretKey);
  }

  get baseUrl(): string {
    return this.opts.baseUrl.replace(/\/+$/, '');
  }

  /** Caller's wallet pubkey (base58). The owner of the USDC ATA we pay from. */
  get authorityAddress(): string {
    return this.web3Keypair.publicKey.toBase58();
  }

  /** Caller's on-chain agent asset address (only set when paymentSource='pda'). */
  get agentAssetAddress(): string | undefined {
    return this.opts.agentAssetAddress;
  }

  /**
   * Return a valid bearer token, performing the handshake on demand.
   * Returns `null` when we can't authenticate (no agent asset address,
   * handshake failed, network issue) — callers should proceed
   * unauthenticated and let the x402 path handle payment.
   *
   * Handshake steps:
   *   1. GET /auth/challenge → nonce.
   *   2. Build a canonical AuthHandshake { pubkey, agentAsset, audience,
   *      nonce, issuedAt, expiresAt }, sign canonical JSON with the
   *      agent keypair (Ed25519).
   *   3. POST /auth/handshake { handshake, signature } → bearer token.
   */
  async getBearer(): Promise<string | null> {
    if (!this.opts.agentAssetAddress) return null;

    const now = Date.now();
    // 30s skew buffer — refresh before the server's own check trips.
    if (this._bearer && this._bearer.expiresAt - 30_000 > now) {
      return this._bearer.token;
    }
    if (this._handshakeInFlight) return this._handshakeInFlight;

    this._handshakeInFlight = this.doHandshake()
      .catch((err) => {
        console.warn(
          '[plumber-client] handshake failed, falling back to x402:',
          err instanceof Error ? err.message : err,
        );
        return null;
      })
      .finally(() => {
        this._handshakeInFlight = null;
      });

    return this._handshakeInFlight;
  }

  /** Force a fresh handshake on the next call (used after a 401). */
  invalidateBearer(): void {
    this._bearer = null;
  }

  private async doHandshake(): Promise<string | null> {
    const baseFetch = globalThis.fetch.bind(globalThis);
    const challengeRes = await baseFetch(`${this.baseUrl}/auth/challenge`);
    if (!challengeRes.ok) {
      throw new Error(`/auth/challenge HTTP ${challengeRes.status}`);
    }
    const { nonce } = (await challengeRes.json()) as { nonce: string };
    if (!nonce) throw new Error('/auth/challenge missing nonce');

    const issuedAt = new Date().toISOString();
    // Server enforces ≤ 5 min, we use 5 min minus a small skew to stay safe.
    const expiresAt = new Date(Date.now() + 4 * 60_000).toISOString();
    const handshake = {
      pubkey: this.authorityAddress,
      agentAsset: this.opts.agentAssetAddress!,
      audience: this.baseUrl,
      nonce,
      issuedAt,
      expiresAt,
    };
    // Canonical JSON: sorted keys, no whitespace — must match plumber's
    // canonicalizeHandshake() exactly so the signature verifies.
    const canonical = JSON.stringify(
      Object.fromEntries(
        Object.keys(handshake).sort().map((k) => [k, handshake[k as keyof typeof handshake]]),
      ),
    );
    const message = new TextEncoder().encode(canonical);
    const sigBytes = nacl.sign.detached(message, this.opts.agentKeypair.secretKey);
    const signature = bs58.encode(sigBytes);

    const handshakeRes = await baseFetch(`${this.baseUrl}/auth/handshake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handshake, signature }),
    });
    if (!handshakeRes.ok) {
      let reason = `HTTP ${handshakeRes.status}`;
      try {
        const body = (await handshakeRes.json()) as { error?: string };
        if (body?.error) reason = String(body.error);
      } catch { /* ignore */ }
      throw new Error(`/auth/handshake rejected: ${reason}`);
    }
    const { token } = (await handshakeRes.json()) as { token: string };
    if (!token) throw new Error('/auth/handshake missing token');

    // Plumber's bearer TTL is 15 min server-side. Mirror that so we know
    // when to refresh; we'll re-handshake 30s before the deadline.
    this._bearer = { token, expiresAt: Date.now() + 15 * 60_000 };
    return token;
  }

  /**
   * Build a base64-encoded partially-signed transaction that satisfies a
   * given x402 payment requirement.
   *
   * Plumber's verifier accepts ANY tx that includes a payment instruction
   * matching the requirement — instruction order doesn't matter, compute-
   * budget instructions are optional, and we don't have to pad to a strict
   * spec layout. We build the smallest tx that works:
   *
   *   - `asset === "SOL"`  → SystemProgram.transfer + optional Memo
   *   - `asset === <mint>` → TransferChecked + optional Memo
   *     (also matches wSOL when plumber configured `asset: "SOL"`,
   *      but for simplicity our client always picks the native path then)
   */
  async buildPaymentTransaction(req: PaymentRequirements): Promise<string> {
    const extra = req.extra ?? {};
    const feePayerStr = extra.feePayer;
    if (typeof feePayerStr !== 'string') {
      throw new Error('PaymentRequirements.extra.feePayer is required');
    }
    const blockhash = extra.blockhash;
    if (typeof blockhash !== 'string') {
      throw new Error(
        'PaymentRequirements.extra.blockhash is required (plumber should populate this); ' +
          'without it the client cannot build a partial tx without its own RPC',
      );
    }
    const memo = typeof extra.memo === 'string' ? extra.memo : null;

    const source = this.opts.paymentSource ?? 'keypair';
    if (source === 'pda') {
      return this.buildPdaPaymentTransaction({ req, feePayerStr, blockhash, memo });
    }

    const feePayer = new PublicKey(feePayerStr);
    const ixs: TransactionInstruction[] = [];

    if (req.asset === NATIVE_SOL_ASSET) {
      // Native SOL — single SystemProgram.transfer. No token accounts needed.
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: this.web3Keypair.publicKey,
          toPubkey: new PublicKey(req.payTo),
          lamports: BigInt(req.amount),
        }),
      );
    } else {
      // SPL token (USDC, wSOL, etc.) — TransferChecked into the destination ATA.
      const mint = new PublicKey(req.asset);
      const recipientOwner = new PublicKey(req.payTo);
      const tokenProgramId = TOKEN_PROGRAM_ID;
      const sourceAta = getAssociatedTokenAddressSync(
        mint,
        this.web3Keypair.publicKey,
        false,
        tokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const destinationAta = getAssociatedTokenAddressSync(
        mint,
        recipientOwner,
        true, // plumber's recipient is the asset PDA — off-curve
        tokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const decimals = typeof extra.asset_decimals === 'number' ? extra.asset_decimals : 6;
      ixs.push(
        createTransferCheckedInstruction(
          sourceAta,
          mint,
          destinationAta,
          this.web3Keypair.publicKey,
          BigInt(req.amount),
          decimals,
          [],
          tokenProgramId,
        ),
      );
    }

    // Memo (optional — included when plumber asked for one).
    if (memo) {
      ixs.push(
        new TransactionInstruction({
          programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
          keys: [],
          data: Buffer.from(memo, 'utf8'),
        }),
      );
    }

    const message = new TransactionMessage({
      payerKey: feePayer,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([this.web3Keypair]);
    // Note: `sign` puts our signature in the slot for our pubkey; the feePayer
    // slot remains zero-bytes until plumber co-signs. Partial-signed.

    return Buffer.from(tx.serialize()).toString('base64');
  }

  /**
   * Build a SOL payment tx where the **agent's mpl-core asset signer PDA**
   * is the source of funds. The tx wraps an inner `transferSol` (PDA → payTo)
   * in an Execute CPI; our executive keypair signs the Execute, and the PDA
   * signs implicitly via the CPI. Plumber co-signs as fee-payer on the
   * outer tx.
   *
   * Built with an offline Umi instance — no Solana RPC calls. The Umi-built
   * transaction is converted to a web3.js `VersionedTransaction` so we can
   * partial-sign with just our keypair (Umi's `buildAndSign` would attempt
   * to sign as every signer in scope, which is fine since the feePayer is
   * a `createNoopSigner` — but the explicit conversion makes the partial-
   * signing semantics easier to reason about).
   */
  private async buildPdaPaymentTransaction(args: {
    req: PaymentRequirements;
    feePayerStr: string;
    blockhash: string;
    memo: string | null;
  }): Promise<string> {
    const { req, feePayerStr, blockhash, memo } = args;
    if (req.asset !== NATIVE_SOL_ASSET) {
      throw new Error(
        'PDA source payments currently only support native SOL ' +
          `(requirement.asset=${req.asset}); use paymentSource:'keypair' for SPL payments`,
      );
    }
    if (!this.opts.agentAssetAddress) {
      throw new Error(
        'paymentSource: "pda" requires agentAssetAddress to be set on PlumberClientOptions',
      );
    }

    // Offline Umi — placeholder endpoint, we never call rpc on it.
    const offlineUmi = createUmiBase('https://offline.local/').use(mplToolbox());
    const executiveSigner = createSignerFromKeypair(offlineUmi, this.opts.agentKeypair);
    offlineUmi.use(signerIdentity(executiveSigner));

    const agentAsset = umiPubkey(this.opts.agentAssetAddress);
    const callerPda = findAssetSignerPda(offlineUmi, { asset: agentAsset })[0];
    const lamports = BigInt(req.amount);
    const inner = transferSol(offlineUmi, {
      source: createNoopSigner(callerPda),
      destination: umiPubkey(req.payTo),
      // mpl-toolbox's `transferSol` accepts `sol(n)` where n is whole SOL.
      // Pass lamports as fraction: `Number(lamports) / 1e9`. Precision loss
      // is irrelevant here — amount fits in a u53 for any realistic payment.
      amount: sol(Number(lamports) / 1_000_000_000),
    });

    let builder = execute(offlineUmi, {
      asset: { publicKey: agentAsset },
      instructions: inner,
    });

    if (memo) {
      builder = builder.add(
        transactionBuilder([
          {
            instruction: {
              programId: umiPubkey(MEMO_PROGRAM_PUBKEY),
              keys: [],
              data: new TextEncoder().encode(memo),
            },
            signers: [],
            bytesCreatedOnChain: 0,
          },
        ]),
      );
    }

    // Plumber's keypair is the outer-tx fee payer; we represent it as a
    // noop signer so Umi's buildAndSign won't try to sign as it.
    const feePayerSigner = createNoopSigner(umiPubkey(feePayerStr));
    builder = builder.setFeePayer(feePayerSigner).setBlockhash(blockhash);

    const umiTx = await builder.buildAndSign(offlineUmi);
    // Convert to web3.js v0 — same wire format, easier serialization.
    const web3Tx = toWeb3JsTransaction(umiTx);
    return Buffer.from(web3Tx.serialize()).toString('base64');
  }
}

/**
 * Build a `fetch` impl that talks to plumber on behalf of `client`:
 *
 *   - On HTTP 402, parse the canonical `PaymentRequired` body, build a
 *     partially-signed tx, base64-encode it as `PaymentPayload`, retry once
 *     with the `X-PAYMENT` header.
 *   - On HTTP 200 with `X-PAYMENT-RESPONSE`, decode the settlement info and
 *     log the on-chain signature (the response body is unchanged).
 *
 * AI SDK's `createOpenAICompatible({ fetch })` and Solana web3.js's
 * `Connection({ fetch })` both consume this directly.
 */
export function plumberFetch(client: PlumberClient): typeof globalThis.fetch {
  const baseFetch = globalThis.fetch.bind(globalThis);

  return async function plumberWrappedFetch(input, init) {
    const initialBody = init?.body;
    const doRequest = async (extraHeaders: Record<string, string>): Promise<Response> => {
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
      return baseFetch(input, { ...init, headers, body: initialBody });
    };

    // Best-effort handshake. If it returns null (no asset, not delegated,
    // network error) we just skip the Authorization header — plumber will
    // answer with HTTP 402 and the x402 retry below kicks in.
    const authHeaders: Record<string, string> = {};
    const bearer = await client.getBearer();
    if (bearer) authHeaders['Authorization'] = `Bearer ${bearer}`;

    let res = await doRequest(authHeaders);

    // 401 → bearer expired/rejected. Force a fresh handshake and retry
    // once. We don't loop further — if the second attempt also 401s, the
    // delegation likely isn't valid; let the response surface to the caller.
    if (res.status === 401 && bearer) {
      client.invalidateBearer();
      const fresh = await client.getBearer();
      const retryHeaders: Record<string, string> = {};
      if (fresh) retryHeaders['Authorization'] = `Bearer ${fresh}`;
      res = await doRequest(retryHeaders);
    }

    if (res.status === 402) {
      const urlForLog =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();
      console.log(`[plumber-client] 402 from ${urlForLog} — building payment`);
      const cloned = res.clone();
      let parsed: PaymentRequired;
      try {
        parsed = (await cloned.json()) as PaymentRequired;
      } catch {
        return res;
      }
      if (parsed?.x402Version !== 2 || !Array.isArray(parsed.accepts) || parsed.accepts.length === 0) {
        return res;
      }
      const requirement = parsed.accepts[0]!;
      console.log(
        `[plumber-client] x402 amount=${requirement.amount} asset=${requirement.asset} ` +
          `payTo=${requirement.payTo} memo=${(requirement.extra as { memo?: string })?.memo}`,
      );
      const base64Tx = await client.buildPaymentTransaction(requirement);
      const paymentPayload: PaymentPayload = {
        x402Version: 2,
        accepted: requirement,
        payload: { transaction: base64Tx },
      };
      const headerValue = Buffer.from(JSON.stringify(paymentPayload), 'utf8').toString('base64');
      res = await doRequest({ 'X-PAYMENT': headerValue });

      const settleHeader = res.headers.get('x-payment-response');
      if (settleHeader) {
        try {
          const settle = JSON.parse(
            Buffer.from(settleHeader, 'base64').toString('utf8'),
          ) as SettleResponse;
          console.log(
            `[plumber-client] settled: tx=${settle.transaction} payer=${settle.payer}`,
          );
          emitPaymentEvent({
            kind: 'x402-paid',
            label: `x402 ${endpointLabel(urlForLog)}`,
            from: settle.payer ?? null,
            to: requirement.payTo,
            amount: requirement.amount,
            unit: requirement.asset === NATIVE_SOL_ASSET ? 'lamports' : requirement.asset,
            signature: settle.transaction,
            cluster: parseSolanaCluster(settle.network),
            ts: new Date().toISOString(),
            detail: {
              endpoint: urlForLog,
              memo: (requirement.extra as { memo?: string })?.memo,
              network: settle.network,
            },
          });
        } catch {
          /* ignore */
        }
      } else if (res.status >= 400) {
        emitPaymentEvent({
          kind: 'x402-rejected',
          label: `x402 retry rejected (HTTP ${res.status})`,
          to: requirement.payTo,
          amount: requirement.amount,
          unit: requirement.asset === NATIVE_SOL_ASSET ? 'lamports' : requirement.asset,
          ts: new Date().toISOString(),
          detail: { endpoint: urlForLog, status: res.status },
        });
      }
    } else {
      // Non-402 success or error. If the server settled via the delegate
      // rail it'll attach `X-Plumber-Charge-Signature` — surface that as
      // a delegate-pay ledger event.
      const chargeSig = res.headers.get('x-plumber-charge-signature');
      if (chargeSig) {
        const urlForLog =
          typeof input === 'string'
            ? input
            : input instanceof Request
              ? input.url
              : input.toString();
        emitPaymentEvent({
          kind: 'delegate-charge',
          label: `delegate-pay ${endpointLabel(urlForLog)}`,
          from: client.agentAssetAddress
            ? `PDA(${client.agentAssetAddress.slice(0, 6)}…)`
            : null,
          to: null,
          signature: chargeSig,
          ts: new Date().toISOString(),
          detail: { endpoint: urlForLog, rail: res.headers.get('x-plumber-charge-rail') },
        });
      }
    }

    return res;
  };
}

/** Strip a plumber URL down to its route label, e.g. `/v1/chat/completions`. */
function endpointLabel(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Parse CAIP-2 `solana:<genesis>` into a cluster name plumber's network uses. */
function parseSolanaCluster(
  network: string,
): 'devnet' | 'mainnet-beta' | 'testnet' | null {
  if (network.includes('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')) return 'mainnet-beta';
  if (network.includes('EtWTRABZaYq6iMfeYKouRu166VU2xqa1')) return 'devnet';
  return null;
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

let _client: PlumberClient | null = null;

export interface PlumberClientConfig {
  baseUrl: string;
  agentKeypair: UmiKeypair;
  paymentSource?: PaymentSource;
  agentAssetAddress?: string;
}

export function setPlumberClient(client: PlumberClient | null): void {
  _client = client;
}

export function getPlumberClient(): PlumberClient | null {
  return _client;
}

export function initPlumberClient(config: PlumberClientConfig): PlumberClient {
  if (_client) return _client;
  _client = new PlumberClient(config);
  return _client;
}

// ---------------------------------------------------------------------------
// Diagnostics: ATA derivation for the agent's USDC source. The boot/setup
// path can use this to confirm the agent has a USDC ATA before clients
// start sending requests.
// ---------------------------------------------------------------------------

export function deriveSourceAta(args: {
  keypairPubkey: string;
  mint: string;
}): string {
  return getAssociatedTokenAddressSync(
    new PublicKey(args.mint),
    new PublicKey(args.keypairPubkey),
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ).toBase58();
}

// Silence unused-import warnings for symbols we'll wire in once the
// destination-ATA-creation path is supported.
void createAssociatedTokenAccountInstruction;
void TOKEN_2022_PROGRAM_ID;
