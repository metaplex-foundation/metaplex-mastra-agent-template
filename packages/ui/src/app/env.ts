export type SolanaCluster = 'mainnet-beta' | 'devnet' | 'testnet';

const VALID_CLUSTERS: SolanaCluster[] = ['mainnet-beta', 'devnet', 'testnet'];

/**
 * WebSocket base URL (no auth token). The token is sent via the
 * `Sec-WebSocket-Protocol` subprotocol on connect, not via a query
 * string, so it doesn't leak through Referer, history, or proxy logs.
 */
export function wsUrl(): string {
  const host = process.env.NEXT_PUBLIC_WS_HOST || 'localhost';
  const port = process.env.NEXT_PUBLIC_WS_PORT || '3002';
  return `ws://${host}:${port}`;
}

/** Bearer token to hand the server via the `bearer` subprotocol. */
export function wsToken(): string {
  return process.env.NEXT_PUBLIC_WS_TOKEN || '';
}

/**
 * Backwards-compatible alias. New code should prefer `wsUrl()` +
 * `wsToken()` and pass the token via WebSocket subprotocol.
 */
export function getWsUrl(): string {
  return wsUrl();
}

/**
 * Which Solana cluster the UI should link to for explorer URLs. Read
 * from `NEXT_PUBLIC_SOLANA_CLUSTER`; defaults to `devnet`. Any invalid
 * value also falls back to `devnet` rather than throwing at runtime.
 */
export function solanaCluster(): SolanaCluster {
  const raw = process.env.NEXT_PUBLIC_SOLANA_CLUSTER;
  if (raw && (VALID_CLUSTERS as string[]).includes(raw)) {
    return raw as SolanaCluster;
  }
  return 'devnet';
}
