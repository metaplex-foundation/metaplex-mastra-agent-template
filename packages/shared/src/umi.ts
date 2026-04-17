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
