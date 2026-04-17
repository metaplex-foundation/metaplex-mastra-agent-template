import {
  publicKey as toPublicKey,
  type Umi,
  type Transaction,
} from '@metaplex-foundation/umi';
import { base64 } from '@metaplex-foundation/umi/serializers';
import { findAssociatedTokenPda } from '@metaplex-foundation/mpl-toolbox';
import bs58 from 'bs58';
import { getConfig } from './config.js';

export interface SwapParams {
  walletAddress: string;
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
}

export interface SwapResult {
  signature: string;
  inputAmount: string;
  outputAmount: string;
  priceImpact: string;
}

interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  otherAmountThreshold?: string;
  routePlan: unknown[];
  [key: string]: unknown;
}

interface SwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
}

const JUPITER_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_URL = 'https://api.jup.ag/swap/v1/swap';

export async function getSwapQuote(params: SwapParams): Promise<QuoteResponse> {
  const config = getConfig();
  const url = new URL(JUPITER_QUOTE_URL);
  url.searchParams.set('inputMint', params.inputMint);
  url.searchParams.set('outputMint', params.outputMint);
  url.searchParams.set('amount', params.amount);
  url.searchParams.set('slippageBps', String(params.slippageBps ?? 50));

  const headers: Record<string, string> = {};
  if (config.JUPITER_API_KEY) {
    headers['x-api-key'] = config.JUPITER_API_KEY;
  }

  const response = await fetch(url.toString(), { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Jupiter quote failed (${response.status}): ${body}`);
  }

  const quote = (await response.json()) as QuoteResponse;

  // Price-impact guard: Jupiter returns `priceImpactPct` as a decimal-string
  // fraction (e.g. "0.0123" = 1.23%). Reject quotes whose price impact exceeds
  // the configured maximum so a prompt-injected / hallucinated swap can't drain
  // a treasury via a sparse pool.
  const rawImpact = quote.priceImpactPct;
  if (rawImpact !== undefined && rawImpact !== null && rawImpact !== '') {
    const impactFraction = parseFloat(String(rawImpact));
    if (!Number.isNaN(impactFraction)) {
      const maxFraction = config.MAX_PRICE_IMPACT_PCT / 100;
      if (impactFraction > maxFraction) {
        const impactPct = (impactFraction * 100).toFixed(2);
        throw new Error(
          `Price impact ${impactPct}% exceeds configured max of ${config.MAX_PRICE_IMPACT_PCT}%`,
        );
      }
    }
  }

  return quote;
}

export async function getSwapTransaction(
  walletAddress: string,
  quoteResponse: QuoteResponse
): Promise<SwapResponse> {
  const config = getConfig();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.JUPITER_API_KEY) {
    headers['x-api-key'] = config.JUPITER_API_KEY;
  }

  const response = await fetch(JUPITER_SWAP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: walletAddress,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Jupiter swap failed (${response.status}): ${body}`);
  }

  return response.json() as Promise<SwapResponse>;
}

// ---------------------------------------------------------------------------
// C6 Simulation-based integrity check
// ---------------------------------------------------------------------------

interface SimulateExpected {
  inputMint: string;
  amountIn: bigint;
  outputMint: string;
  minAmountOut: bigint;
}

/** Native SOL pseudo-mint used by Jupiter when `wrapAndUnwrapSol: true`. */
const SOL_PSEUDO_MINT = 'So11111111111111111111111111111111111111112';

interface RpcAccountData {
  data: [string, string] | null; // [base64Data, encoding]
  lamports: number;
  owner: string;
  executable?: boolean;
  rentEpoch?: number;
}

interface SimulateTransactionResponse {
  value: {
    err: unknown;
    logs?: string[] | null;
    accounts?: (RpcAccountData | null)[] | null;
    unitsConsumed?: number;
  };
}

/**
 * SPL Token account layout (partial): the `amount` u64 is at offset 64.
 * Both the classic Token program and Token-2022 share this prefix.
 */
function readTokenAccountAmount(dataBase64: string): bigint | null {
  try {
    const buf = Buffer.from(dataBase64, 'base64');
    if (buf.length < 72) return null;
    return buf.readBigUInt64LE(64);
  } catch {
    return null;
  }
}

/**
 * Simulate a Jupiter-built swap transaction against the RPC and verify that
 * the agent's own token accounts move by amounts consistent with the quote.
 *
 * Asserts:
 *  - Input debit ≤ `amountIn * 1.01` (1% buffer for fees / rounding).
 *  - Output credit ≥ `minAmountOut * 0.99` (1% buffer for slippage drift).
 *
 * **Fail-safe policy:** if simulation itself fails (RPC unavailable, response
 * unparseable, SPL account layout mismatch) we log a warning and return
 * without throwing. The existing signer-slot check + slippage cap + quote
 * price-impact cap remain as defence-in-depth. Failing closed here would
 * break swaps on any RPC that doesn't support the `accounts` field of
 * `simulateTransaction`.
 *
 * Throws an `Error` tagged with `INTEGRITY` in its message on a real mismatch
 * — the downstream tool's catch block will classify this via `toToolError`.
 */
export async function simulateAndVerifySwap(
  umi: Umi,
  tx: Transaction,
  expected: SimulateExpected,
): Promise<void> {
  try {
    const agentOwner = umi.identity.publicKey;

    // Only watch non-SOL ATAs. Native SOL appears as lamport deltas on the
    // system account rather than as SPL token balances, and Jupiter often
    // wraps/unwraps SOL through the WSOL ATA with transient balances that
    // are hard to reason about in a simulation.
    const watchInput = expected.inputMint !== SOL_PSEUDO_MINT;
    const watchOutput = expected.outputMint !== SOL_PSEUDO_MINT;

    const addresses: string[] = [];
    let inputAtaIndex = -1;
    let outputAtaIndex = -1;

    if (watchInput) {
      const [ata] = findAssociatedTokenPda(umi, {
        mint: toPublicKey(expected.inputMint),
        owner: agentOwner,
      });
      inputAtaIndex = addresses.length;
      addresses.push(ata.toString());
    }

    if (watchOutput) {
      const [ata] = findAssociatedTokenPda(umi, {
        mint: toPublicKey(expected.outputMint),
        owner: agentOwner,
      });
      outputAtaIndex = addresses.length;
      addresses.push(ata.toString());
    }

    // Nothing meaningful to verify (pure SOL in, SOL out can't happen anyway).
    if (addresses.length === 0) return;

    // Snapshot pre-balances directly from chain so we can diff against the
    // post-sim account states that `simulateTransaction` returns.
    const preBalances: (bigint | null)[] = await Promise.all(
      addresses.map(async (addr) => {
        try {
          const account = await umi.rpc.getAccount(toPublicKey(addr), {
            commitment: 'confirmed',
          });
          if (!account.exists) return 0n;
          const data = (account as unknown as { data: Uint8Array }).data;
          if (!data || data.length < 72) return 0n;
          return Buffer.from(data).readBigUInt64LE(64);
        } catch {
          return null;
        }
      }),
    );

    const serialized = umi.transactions.serialize(tx);
    const txBase64 = base64.deserialize(serialized)[0];

    const simResponse = await umi.rpc.call<SimulateTransactionResponse>(
      'simulateTransaction',
      [
        txBase64,
        {
          encoding: 'base64',
          replaceRecentBlockhash: true,
          sigVerify: false,
          commitment: 'confirmed',
          accounts: {
            encoding: 'base64',
            addresses,
          },
        },
      ],
    );

    const value = simResponse?.value;
    if (!value) {
      console.warn('[jupiter:simulate] no value in simulateTransaction response; skipping integrity check');
      return;
    }

    if (value.err) {
      // Simulation-failed transactions aren't an integrity problem per se —
      // real send will also fail. Log + fall through (existing signer-slot
      // check already gated us this far).
      console.warn(
        '[jupiter:simulate] simulation returned err; leaving integrity check as a warning',
        JSON.stringify(value.err),
      );
      return;
    }

    const accounts = value.accounts;
    if (!accounts || accounts.length !== addresses.length) {
      console.warn('[jupiter:simulate] accounts array missing from sim; skipping integrity check');
      return;
    }

    if (watchInput && inputAtaIndex >= 0) {
      const preAmount = preBalances[inputAtaIndex];
      const postAccount = accounts[inputAtaIndex];
      const postAmount =
        postAccount && postAccount.data
          ? readTokenAccountAmount(postAccount.data[0])
          : 0n; // account closed / doesn't exist after tx
      if (preAmount !== null && postAmount !== null) {
        const debit = preAmount - postAmount;
        // amountIn * 1.01 with integer math: ceil(amountIn * 101 / 100).
        const maxDebit = (expected.amountIn * 101n + 99n) / 100n;
        if (debit > maxDebit) {
          throw new Error(
            `INTEGRITY: Jupiter swap would debit ${debit.toString()} of input mint ` +
              `${expected.inputMint} but quote amountIn is ${expected.amountIn.toString()}. ` +
              'Refusing to sign.',
          );
        }
      }
    }

    if (watchOutput && outputAtaIndex >= 0) {
      const preAmount = preBalances[outputAtaIndex] ?? 0n;
      const postAccount = accounts[outputAtaIndex];
      const postAmount =
        postAccount && postAccount.data
          ? readTokenAccountAmount(postAccount.data[0])
          : null;
      if (preAmount !== null && postAmount !== null) {
        const credit = postAmount - preAmount;
        // minAmountOut * 0.99 with integer math: floor(minAmountOut * 99 / 100).
        const minCredit = (expected.minAmountOut * 99n) / 100n;
        if (credit < minCredit) {
          throw new Error(
            `INTEGRITY: Jupiter swap would credit only ${credit.toString()} of output mint ` +
              `${expected.outputMint} but quote minAmountOut is ${expected.minAmountOut.toString()}. ` +
              'Refusing to sign.',
          );
        }
      }
    }
  } catch (error) {
    // Only rethrow the INTEGRITY signal. Anything else is a simulation or
    // infrastructure failure that must not fail the swap closed.
    if (error instanceof Error && error.message.startsWith('INTEGRITY:')) {
      throw error;
    }
    console.warn(
      '[jupiter:simulate] integrity check skipped:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Execute a swap via Jupiter. The transaction is signed by umi.identity
 * (the agent keypair). Note: Jupiter swaps cannot be routed through Core
 * Execute CPI because Jupiter returns a complete versioned transaction,
 * not decomposable instructions. The agent's trading funds must be in the
 * keypair wallet for swaps.
 */
export async function executeSwap(
  umi: Umi,
  params: SwapParams
): Promise<SwapResult> {
  const quote = await getSwapQuote(params);
  const swapResponse = await getSwapTransaction(params.walletAddress, quote);
  const { swapTransaction } = swapResponse;

  // Decode the base64 transaction from Jupiter into a Uint8Array
  // (Umi's SerializedTransaction type is Uint8Array)
  const txBytes = new Uint8Array(Buffer.from(swapTransaction, 'base64'));
  const transaction = umi.transactions.deserialize(txBytes);

  // Integrity check: Jupiter returns a fully-built transaction. Before we sign
  // with the agent's keypair, confirm that only the agent is a required signer.
  // Any other signer slot indicates the route is asking a third party to
  // authorize (which we cannot satisfy) or trying to smuggle in an unexpected
  // co-signer. Refuse to sign in either case.
  const expectedSigner = umi.identity.publicKey.toString();
  const numRequiredSignatures = transaction.message.header.numRequiredSignatures;
  const signerSlots = transaction.message.accounts.slice(0, numRequiredSignatures);
  for (const signer of signerSlots) {
    const signerStr = signer.toString();
    if (signerStr !== expectedSigner) {
      throw new Error(
        `Jupiter transaction requires unexpected signer ${signerStr}; refusing to sign. ` +
        `Expected only ${expectedSigner}.`,
      );
    }
  }
  if (signerSlots.length === 0) {
    throw new Error(
      `Jupiter transaction has no required signer slots; refusing to sign. ` +
      `Expected ${expectedSigner}.`,
    );
  }

  // C6 deep integrity: simulate and verify token-balance deltas on the
  // agent's ATAs against the quote's advertised amounts before signing.
  // `otherAmountThreshold` is the quote's min-out (slippage-adjusted); fall
  // back to `outAmount` if absent.
  const minOutStr = quote.otherAmountThreshold ?? quote.outAmount;
  try {
    await simulateAndVerifySwap(umi, transaction, {
      inputMint: params.inputMint,
      amountIn: BigInt(quote.inAmount),
      outputMint: params.outputMint,
      minAmountOut: BigInt(minOutStr),
    });
  } catch (error) {
    // Rethrow so the downstream tool classifies + returns `err('INTEGRITY', ...)`.
    throw error;
  }

  const signedTx = await umi.identity.signTransaction(transaction);
  const signature = await umi.rpc.sendTransaction(signedTx);
  const signatureStr = bs58.encode(signature);

  // Confirm using the lastValidBlockHeight from the Jupiter swap response,
  // paired with the blockhash embedded in the transaction itself. This avoids
  // the race condition of fetching a new blockhash after send.
  const txMessage = transaction.message;
  const blockhash = typeof txMessage.blockhash === 'string'
    ? txMessage.blockhash
    : (await umi.rpc.getLatestBlockhash()).blockhash;
  await umi.rpc.confirmTransaction(signature, {
    strategy: {
      type: 'blockhash',
      blockhash,
      lastValidBlockHeight: swapResponse.lastValidBlockHeight,
    },
  });

  return {
    signature: signatureStr,
    inputAmount: quote.inAmount,
    outputAmount: quote.outAmount,
    priceImpact: quote.priceImpactPct,
  };
}

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
