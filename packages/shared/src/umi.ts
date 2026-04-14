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
 * Creates a configured Umi instance based on the current environment.
 *
 * - Always registers the mpl-toolbox plugin
 * - In autonomous mode: loads the agent keypair and sets it as identity/payer
 * - In public mode: no signer configured (transactions are sent to the frontend)
 */
export function createUmi(): Umi {
  const config = getConfig();
  const umi = createUmiBase(config.SOLANA_RPC_URL).use(mplToolbox());

  if (config.AGENT_MODE === 'autonomous') {
    if (!config.AGENT_KEYPAIR) {
      throw new Error(
        'AGENT_KEYPAIR is required in autonomous mode. Set it in your .env file.'
      );
    }
    const secretKey = bs58.decode(config.AGENT_KEYPAIR);
    const keypair = umi.eddsa.createKeypairFromSecretKey(secretKey);
    const signer = createSignerFromKeypair(umi, keypair);
    umi.use(signerIdentity(signer));
  }

  return umi;
}
