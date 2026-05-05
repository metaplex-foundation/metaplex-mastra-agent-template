export type AuthMode = 'owner' | 'allowlist' | 'open';

export interface AuthCheck {
  mode: AuthMode;
  publicKey: string;
  owner: string | null;
  allowlist: readonly string[];
}

/**
 * Pure auth-tier resolver. Caller MUST have already verified that
 * `publicKey` is a valid Ed25519 pubkey AND that the connecting client
 * proved possession of it (e.g. via SIWS signature). This function only
 * decides "is this verified pubkey on the guest list for the current tier".
 *
 * Owner precedence: a non-null `owner` matching `publicKey` is always
 * authorized regardless of `mode`, so the operator can always reach their
 * own agent without listing themselves.
 *
 * No normalization: base58 is case-sensitive and pubkeys are assumed
 * canonical at this layer (the loader trims; on-chain owner comes from
 * `PublicKey.toString()`).
 */
export function isAuthorized(c: AuthCheck): boolean {
  if (c.owner !== null && c.publicKey === c.owner) return true;

  switch (c.mode) {
    case 'owner':
      return false;
    case 'allowlist':
      return c.allowlist.includes(c.publicKey);
    case 'open':
      return true;
    default: {
      // Exhaustiveness guard — if a new AuthMode is added without a
      // matching case, TypeScript catches it here at compile time AND
      // the runtime throw fails closed instead of silently returning
      // undefined (which would be an auth bypass).
      const _exhaustive: never = c.mode;
      throw new Error(`unreachable auth mode: ${_exhaustive as string}`);
    }
  }
}
