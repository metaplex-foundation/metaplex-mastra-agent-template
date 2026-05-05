import nacl from 'tweetnacl';
import bs58 from 'bs58';

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

export interface VerifySiwsParams {
  message: string;
  signatureBase58: string;
  publicKeyBase58: string;
}

export function verifySiwsSignature(p: VerifySiwsParams): boolean {
  let sig: Uint8Array;
  let pk: Uint8Array;
  try {
    sig = bs58.decode(p.signatureBase58);
    pk = bs58.decode(p.publicKeyBase58);
  } catch {
    return false;
  }
  if (sig.length !== 64 || pk.length !== 32) return false;
  const msgBytes = new TextEncoder().encode(p.message);
  try {
    return nacl.sign.detached.verify(msgBytes, sig, pk);
  } catch {
    return false;
  }
}
