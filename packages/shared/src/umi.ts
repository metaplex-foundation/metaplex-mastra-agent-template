import { createUmi as createUmiBase } from '@metaplex-foundation/umi-bundle-defaults';
import {
  createSignerFromKeypair,
  signerIdentity,
  type Keypair,
  type Umi,
} from '@metaplex-foundation/umi';
import { mplToolbox } from '@metaplex-foundation/mpl-toolbox';
import bs58 from 'bs58';
import { getConfig } from './config.js';
import {
  getPlumberClient,
  initPlumberClient,
  plumberFetch,
  PlumberClient,
} from './plumber-client.js';

/**
 * Creates a configured Umi instance with the agent keypair as identity/payer.
 *
 * Two modes:
 *   - **Direct RPC** (default when `PLUMBER_URL` is unset): connects straight
 *     to `SOLANA_RPC_URL`. Escape hatch for forks that don't want plumber.
 *   - **Plumber-backed** (when `PLUMBER_URL` is set): Umi's RPC layer points
 *     at `${PLUMBER_URL}/v1/solana/rpc` and the underlying web3.js
 *     `Connection` uses `plumberFetch` so every JSON-RPC call gets the x402
 *     pay-and-retry seam transparently. No `SOLANA_RPC_URL` needed — the
 *     template makes ZERO direct Solana calls in this mode.
 */
export function createUmi(): Umi {
  const config = getConfig();
  const keypair = loadAgentKeypair();

  if (config.PLUMBER_URL) {
    const client = ensurePlumberClient(config.PLUMBER_URL, keypair);
    return buildPlumberUmi(client, keypair);
  }

  return buildDirectUmi(config.SOLANA_RPC_URL, keypair);
}

function buildDirectUmi(rpcUrl: string, keypair: Keypair): Umi {
  const umi = createUmiBase(rpcUrl).use(mplToolbox());
  const signer = createSignerFromKeypair(umi, keypair);
  umi.use(signerIdentity(signer));
  return umi;
}

function buildPlumberUmi(client: PlumberClient, keypair: Keypair): Umi {
  const endpoint = `${client.baseUrl}/v1/solana/rpc`;
  const umi = createUmiBase(endpoint, {
    commitment: 'confirmed',
    fetch: plumberFetch(client),
  }).use(mplToolbox());
  const signer = createSignerFromKeypair(umi, keypair);
  umi.use(signerIdentity(signer));
  return umi;
}

/**
 * Decode `AGENT_KEYPAIR` to a Umi `Keypair`. Not cached — tests mutate
 * AGENT_KEYPAIR across cases.
 */
export function loadAgentKeypair(): Keypair {
  const config = getConfig();
  const raw = config.AGENT_KEYPAIR.trim();
  const secretKey = raw.startsWith('[')
    ? new Uint8Array(JSON.parse(raw))
    : bs58.decode(raw);
  const umi = createUmiBase('https://api.devnet.solana.com');
  return umi.eddsa.createKeypairFromSecretKey(secretKey);
}

let _keypairPubkeyCache: string | null = null;

export function getAgentKeypairPublicKey(): string {
  if (_keypairPubkeyCache) return _keypairPubkeyCache;
  _keypairPubkeyCache = loadAgentKeypair().publicKey.toString();
  return _keypairPubkeyCache;
}

function ensurePlumberClient(baseUrl: string, keypair: Keypair): PlumberClient {
  const existing = getPlumberClient();
  if (existing) return existing;
  const config = getConfig();
  if (config.PLUMBER_PAYMENT_SOURCE === 'pda' && !config.AGENT_ASSET_ADDRESS) {
    throw new Error(
      'PLUMBER_PAYMENT_SOURCE=pda requires AGENT_ASSET_ADDRESS to be set ' +
        '(the agent must be registered on-chain so its asset PDA can sign payments).',
    );
  }
  return initPlumberClient({
    baseUrl,
    agentKeypair: keypair,
    paymentSource: config.PLUMBER_PAYMENT_SOURCE,
    agentAssetAddress: config.AGENT_ASSET_ADDRESS,
  });
}
