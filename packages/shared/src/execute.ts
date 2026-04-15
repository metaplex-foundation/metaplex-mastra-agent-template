import {
  type Umi,
  type TransactionBuilder,
  type PublicKey,
} from '@metaplex-foundation/umi';
import {
  execute,
  fetchAsset,
  findAssetSignerPda,
} from '@metaplex-foundation/mpl-core';
import bs58 from 'bs58';

/**
 * Wraps instructions in a Core Execute call so the asset signer PDA
 * signs the inner instructions via CPI. The umi.identity (agent keypair)
 * must be the asset owner.
 */
export async function executeAsAgent(
  umi: Umi,
  agentAssetAddress: PublicKey,
  instructions: TransactionBuilder
): Promise<string> {
  const asset = await fetchAsset(umi, agentAssetAddress);

  const tx = execute(umi, {
    asset,
    instructions,
  });

  const result = await tx.sendAndConfirm(umi);
  return bs58.encode(result.signature);
}

/**
 * Derives the asset signer PDA for a given agent asset.
 * This PDA is the agent's operational wallet -- it holds funds
 * and signs instructions via Core Execute CPI.
 */
export function getAgentPda(umi: Umi, agentAssetAddress: PublicKey): PublicKey {
  return findAssetSignerPda(umi, { asset: agentAssetAddress })[0];
}
