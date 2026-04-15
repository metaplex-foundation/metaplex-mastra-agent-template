import {
  type Umi,
  type PublicKey,
} from '@metaplex-foundation/umi';
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

  return response.json() as Promise<QuoteResponse>;
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
  const { swapTransaction } = await getSwapTransaction(params.walletAddress, quote);

  // Decode the base64 transaction from Jupiter into a Uint8Array
  // (Umi's SerializedTransaction type is Uint8Array)
  const txBytes = new Uint8Array(Buffer.from(swapTransaction, 'base64'));
  const transaction = umi.transactions.deserialize(txBytes);
  const signedTx = await umi.identity.signTransaction(transaction);
  const signature = await umi.rpc.sendTransaction(signedTx);
  const signatureStr = bs58.encode(signature);

  // Confirm the transaction using a blockhash strategy
  const latestBlockhash = await umi.rpc.getLatestBlockhash();
  await umi.rpc.confirmTransaction(signature, {
    strategy: {
      type: 'blockhash',
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
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
