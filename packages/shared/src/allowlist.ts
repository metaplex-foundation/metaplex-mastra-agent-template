export type AuthMode = 'owner' | 'allowlist' | 'open';

export interface AuthCheck {
  mode: AuthMode;
  publicKey: string;
  owner: string | null;
  allowlist: readonly string[];
}

export function isAuthorized(c: AuthCheck): boolean {
  // Owner is always authorized regardless of mode (so the operator can
  // always reach their own agent without listing themselves).
  if (c.owner !== null && c.publicKey === c.owner) return true;

  switch (c.mode) {
    case 'owner':
      return false;
    case 'allowlist':
      return c.allowlist.includes(c.publicKey);
    case 'open':
      return true;
  }
}
