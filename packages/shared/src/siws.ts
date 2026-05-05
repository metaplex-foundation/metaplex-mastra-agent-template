export interface SiwsParams {
  agentName: string;
  agentAsset: string | null;
  network: 'solana-mainnet' | 'solana-devnet';
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export function buildSiwsMessage(p: SiwsParams): string {
  return [
    `Sign in to ${p.agentName}`,
    '',
    `Agent: ${p.agentAsset ?? 'unregistered'}`,
    `Network: ${p.network}`,
    `Nonce: ${p.nonce}`,
    `Issued: ${p.issuedAt}`,
    `Expires: ${p.expiresAt}`,
  ].join('\n');
}
