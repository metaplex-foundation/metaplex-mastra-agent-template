import {
  createSignerFromKeypair,
  signerIdentity,
  type Umi,
} from '@metaplex-foundation/umi';
import { createUmi as createUmiBase } from '@metaplex-foundation/umi-bundle-defaults';
import { mplToolbox } from '@metaplex-foundation/mpl-toolbox';
import nacl from 'tweetnacl';
import { blockhashFixture } from './mock-rpc.js';

/**
 * Build a UMI instance pointed at an RPC URL (typically a mock RPC) and
 * signed by a freshly-generated Ed25519 keypair. ZERO_KEYPAIR from env.ts
 * isn't usable here: 64 bytes of 0 fails Ed25519 secret-key validation.
 *
 * Returns `{ umi, publicKey }` so tests can assert against the signer
 * address without re-deriving it.
 */
export function makeTestUmi(rpcUrl: string): { umi: Umi; publicKey: string } {
  const umi = createUmiBase(rpcUrl).use(mplToolbox());
  const kp = nacl.sign.keyPair();
  const keypair = umi.eddsa.createKeypairFromSecretKey(kp.secretKey);
  const signer = createSignerFromKeypair(umi, keypair);
  umi.use(signerIdentity(signer));
  return { umi, publicKey: keypair.publicKey.toString() };
}

/**
 * Override the RPC methods that `submitOrSend` / `buildAndSign` /
 * `sendAndConfirm` exercise so we don't have to drive the full JSON-RPC +
 * confirmation-strategy machinery for unit tests.
 *
 * `getLatestBlockhash` returns the canned fixture (cheap to satisfy).
 * `sendTransaction` returns a fixed 64-byte signature.
 * `confirmTransaction` resolves with a synthetic success value.
 *
 * Each stub records into `calls` so tests can assert which methods fired
 * (e.g. dry-run mode should NEVER call send/confirm).
 */
export interface UmiRpcCalls {
  getLatestBlockhash: number;
  sendTransaction: number;
  confirmTransaction: number;
}

export function stubUmiRpc(umi: Umi): UmiRpcCalls {
  const calls: UmiRpcCalls = {
    getLatestBlockhash: 0,
    sendTransaction: 0,
    confirmTransaction: 0,
  };

  const fixture = blockhashFixture().value;
  // 64-byte signature filled with 1s — base58-encodes to a fixed string.
  const fakeSig = new Uint8Array(64).fill(1);

  (umi.rpc as any).getLatestBlockhash = async () => ({
    blockhash: fixture.blockhash,
    lastValidBlockHeight: fixture.lastValidBlockHeight,
  });

  (umi.rpc as any).sendTransaction = async () => {
    calls.sendTransaction += 1;
    return fakeSig;
  };

  (umi.rpc as any).confirmTransaction = async () => {
    calls.confirmTransaction += 1;
    return { context: { slot: 1 }, value: { err: null } };
  };

  // Wrap getLatestBlockhash to count calls. (Re-assigning after the first
  // override so the counter wraps the same async function.)
  const realGetLatestBlockhash = (umi.rpc as any).getLatestBlockhash;
  (umi.rpc as any).getLatestBlockhash = async (...args: any[]) => {
    calls.getLatestBlockhash += 1;
    return realGetLatestBlockhash(...args);
  };

  return calls;
}
