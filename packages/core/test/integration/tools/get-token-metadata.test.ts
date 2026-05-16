import { test, before, after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import nacl from 'tweetnacl';
import {
  startMockRpc,
  type MockRpc,
} from '../../../../shared/test/helpers/mock-rpc.js';
import {
  isolateEnv,
  restoreEnv,
  defaultTestEnv,
} from '../../../../shared/test/helpers/env.js';
import { _resetConfigForTests } from '@metaplex-foundation/shared';
import { fakeContext } from '../../helpers/mock-context.js';
import { getTokenMetadata } from '../../../src/tools/shared/get-token-metadata.js';

/**
 * Integration tests for `get-token-metadata`.
 *
 * The tool issues `umi.rpc.call('getAsset', [mintAddress])` against a
 * DAS-compatible RPC and pulls `content.metadata.name`,
 * `content.metadata.symbol`, and `content.links.image` from the
 * response (each optional → null fallback).
 *
 * The DAS `getAsset` call goes through UMI's `rpc.call` wrapper, which
 * surfaces underlying JSON-RPC errors as thrown errors. We test:
 *   - Happy path with all three fields present
 *   - Missing fields → null on the missing keys (graceful fallback)
 *   - RPC error → structured error
 */

let rpc: MockRpc;
const AGENT_KEYPAIR = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));
const VALID_MINT = 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2';

before(async () => {
  rpc = await startMockRpc();
});

afterEach(() => {
  restoreEnv();
  _resetConfigForTests();
});

after(async () => {
  await rpc.close();
});

test('get-token-metadata returns name/symbol/image from DAS getAsset', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));
  rpc.on('getAsset', () => ({
    content: {
      metadata: { name: 'Test Token', symbol: 'TST' },
      links: { image: 'https://example.com/image.png' },
    },
  }));

  const result = (await getTokenMetadata.execute!(
    { mintAddress: VALID_MINT },
    { requestContext: fakeContext() } as any,
  )) as any;

  assert.equal(result.status, 'success');
  assert.equal(result.mint, VALID_MINT);
  assert.equal(result.name, 'Test Token');
  assert.equal(result.symbol, 'TST');
  assert.equal(result.image, 'https://example.com/image.png');
});

test('get-token-metadata returns null fields when DAS payload omits them', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));
  // Asset has metadata block but neither name nor symbol nor a links/image —
  // the tool should not throw, just expose nulls. This exercises the `?? null`
  // fallbacks in the success branch.
  rpc.on('getAsset', () => ({
    content: {
      metadata: {},
    },
  }));

  const result = (await getTokenMetadata.execute!(
    { mintAddress: VALID_MINT },
    { requestContext: fakeContext() } as any,
  )) as any;

  assert.equal(result.status, 'success');
  assert.equal(result.name, null);
  assert.equal(result.symbol, null);
  assert.equal(result.image, null);
});

test('get-token-metadata surfaces RPC failure as structured error', async () => {
  isolateEnv(defaultTestEnv({ SOLANA_RPC_URL: rpc.url, AGENT_KEYPAIR }));
  rpc.on('getAsset', () => {
    throw new Error('asset lookup failed');
  });

  const result = (await getTokenMetadata.execute!(
    { mintAddress: VALID_MINT },
    { requestContext: fakeContext() } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.match(result.message, /Failed to fetch token metadata/);
});
