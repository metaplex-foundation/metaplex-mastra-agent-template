import { randomUUID } from 'crypto';
import bs58 from 'bs58';
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
 * Thin auth/payment helper. State-free — every call is a stateless retry on
 * 402. No bearer caching, no handshake (plumber's canonical x402 path
 * doesn't authenticate beyond the payment signature).
 */
export class PlumberClient {
  /** web3.js Keypair derived from the Umi keypair, cached. */
  private readonly web3Keypair: Web3Keypair;

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

    let res = await doRequest({});

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
        } catch {
          /* ignore */
        }
      }
    }

    return res;
  };
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
