import { RequestContext } from '@mastra/core/request-context';

export interface FakeContextOpts {
  walletAddress?: string;
  agentMode?: 'public' | 'autonomous';
  agentAssetAddress?: string | null;
  agentTokenMint?: string | null;
  agentFeeSol?: number;
  tokenOverride?: string | null;
  ownerWallet?: string;
  transactionSender?: (b64: string) => Promise<string>;
  abortSignal?: AbortSignal;
  txCounter?: { count: number; max: number };
}

export function fakeContext(opts: FakeContextOpts = {}): RequestContext {
  const entries: [string, unknown][] = [
    ['walletAddress', opts.walletAddress ?? 'OwnerWalletAddressPlaceholder1111111111111'],
    ['agentMode', opts.agentMode ?? 'public'],
    ['agentAssetAddress', opts.agentAssetAddress ?? null],
    ['agentTokenMint', opts.agentTokenMint ?? null],
    ['agentFeeSol', opts.agentFeeSol ?? 0],
    ['tokenOverride', opts.tokenOverride ?? null],
    ['ownerWallet', opts.ownerWallet ?? 'OwnerWalletAddressPlaceholder1111111111111'],
    ['abortSignal', opts.abortSignal ?? new AbortController().signal],
  ];
  if (opts.transactionSender) entries.push(['transactionSender', opts.transactionSender]);
  if (opts.txCounter) entries.push(['txCounter', opts.txCounter]);
  return new RequestContext(entries);
}
