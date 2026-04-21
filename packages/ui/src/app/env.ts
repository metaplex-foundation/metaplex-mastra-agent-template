export type SolanaCluster = 'mainnet-beta' | 'devnet' | 'testnet';

const VALID_CLUSTERS: SolanaCluster[] = ['mainnet-beta', 'devnet', 'testnet'];

/**
 * WebSocket base URL (no auth token). The token is sent via the
 * `Sec-WebSocket-Protocol` subprotocol on connect, not via a query
 * string, so it doesn't leak through Referer, history, or proxy logs.
 *
 * Protocol selection:
 *   - `NEXT_PUBLIC_WS_PROTOCOL` wins if set (`ws` or `wss`).
 *   - Otherwise `wss` for any non-localhost host, `ws` for localhost.
 *     TLS-terminating hosts (Railway, Fly, Vercel, etc.) only accept `wss`,
 *     and modern browsers block mixed-content `ws://` from an https page.
 *
 * Port handling: if the host is a TLS endpoint served on 443 you can omit
 * `NEXT_PUBLIC_WS_PORT` and we'll drop the port from the URL.
 */
export function wsUrl(): string {
  const host = process.env.NEXT_PUBLIC_WS_HOST || 'localhost';
  const port = process.env.NEXT_PUBLIC_WS_PORT;
  const explicitProto = process.env.NEXT_PUBLIC_WS_PROTOCOL;
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  const proto = explicitProto === 'ws' || explicitProto === 'wss'
    ? explicitProto
    : isLocal ? 'ws' : 'wss';

  // Omit the port when it's the default for the protocol (443 for wss, 80
  // for ws) -- managed TLS hosts typically don't expect an explicit :443.
  const isDefaultPort =
    (proto === 'wss' && (port === '443' || port === undefined)) ||
    (proto === 'ws' && port === '80');

  if (isDefaultPort) return `${proto}://${host}`;
  return `${proto}://${host}:${port ?? (isLocal ? '3002' : '443')}`;
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
