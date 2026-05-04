import { createUmi as createUmiBase } from '@metaplex-foundation/umi-bundle-defaults';
import {
  createSignerFromKeypair,
  signerIdentity,
  type Umi,
} from '@metaplex-foundation/umi';
import { mplToolbox } from '@metaplex-foundation/mpl-toolbox';
import bs58 from 'bs58';
import { getConfig } from './config.js';

/**
 * Creates a configured Umi instance with the agent keypair as identity/payer.
 *
 * - Registers the mpl-toolbox plugin
 * - Loads the agent keypair (AGENT_KEYPAIR) and sets it as identity/payer
 * - Used in both public and autonomous modes
 */
export function createUmi(): Umi {
  const config = getConfig();
  const umi = createUmiBase(config.SOLANA_RPC_URL).use(mplToolbox());

  const raw = config.AGENT_KEYPAIR.trim();
  const secretKey = raw.startsWith('[')
    ? new Uint8Array(JSON.parse(raw))
    : bs58.decode(raw);
  const keypair = umi.eddsa.createKeypairFromSecretKey(secretKey);
  const signer = createSignerFromKeypair(umi, keypair);
  umi.use(signerIdentity(signer));

  return umi;
}

let _keypairPubkeyCache: string | null = null;

/**
 * Returns the base58 public key of the agent keypair (AGENT_KEYPAIR).
 * Cached after first call — the keypair is fixed for the process lifetime.
 *
 * Used to surface the keypair address in the LLM's system prefix so the
 * agent can hand it to users for funding without spinning up a full Umi.
 */
export function getAgentKeypairPublicKey(): string {
  if (_keypairPubkeyCache) return _keypairPubkeyCache;
  const umi = createUmi();
  _keypairPubkeyCache = umi.identity.publicKey.toString();
  return _keypairPubkeyCache;
}
