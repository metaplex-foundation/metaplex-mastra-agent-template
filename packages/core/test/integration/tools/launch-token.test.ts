import { test, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import nacl from 'tweetnacl';
import {
  isolateEnv,
  restoreEnv,
  defaultTestEnv,
} from '../../../../shared/test/helpers/env.js';
import { _resetConfigForTests } from '@metaplex-foundation/shared';
import { fakeContext } from '../../helpers/mock-context.js';
import { launchToken } from '../../../src/tools/shared/launch-token.js';

/**
 * Integration tests for the `launch-token` tool.
 *
 * launch-token wraps `createAndRegisterLaunch` from
 * `@metaplex-foundation/genesis`, which is a deep on-chain flow we can't
 * fully exercise without standing up an RPC fixture for the Genesis program
 * accounts. Per the per-tool guidance, we cover:
 *   1. Refusal when `confirmIrreversible` is missing (Zod rejection).
 *   2. Refusal when `confirmIrreversible !== true` (defensive belt-and-braces).
 *   3. Refusal when the agent isn't registered (NOT_REGISTERED short-circuit).
 *   4. Idempotent return when a token mint is already set.
 *   5. TOKEN_OVERRIDE bypass when the agent is configured to target an
 *      existing token.
 *   6. Zod URL validation on `imageUri`.
 *
 * Skipped: the actual Genesis SDK mint flow (and its associated banner
 * emission, setState, etc.) — exercising that would require a full RPC
 * fixture with the Genesis program loaded.
 */

const AGENT_KEYPAIR = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));
const AGENT_ASSET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const EXISTING_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const IMAGE_URI = 'https://gateway.irys.xyz/abc';

beforeEach(() => {
  isolateEnv(
    defaultTestEnv({
      AGENT_MODE: 'autonomous',
      BOOTSTRAP_WALLET: 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2',
      AGENT_KEYPAIR,
    }),
  );
  _resetConfigForTests();
});

afterEach(() => {
  restoreEnv();
  _resetConfigForTests();
});

test('launch-token rejects when confirmIrreversible is missing (Zod)', async () => {
  const result = (await launchToken.execute!(
    {
      name: 'My Token',
      symbol: 'TOK',
      imageUri: IMAGE_URI,
    } as any,
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
      }),
    } as any,
  )) as any;

  assert.equal(result.error, true);
});

test('launch-token rejects when confirmIrreversible is literal false (Zod)', async () => {
  const result = (await launchToken.execute!(
    {
      name: 'My Token',
      symbol: 'TOK',
      imageUri: IMAGE_URI,
      confirmIrreversible: false,
    } as any,
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
      }),
    } as any,
  )) as any;

  // Zod literal(true) makes false fail schema parsing.
  assert.equal(result.error, true);
});

test('launch-token returns NOT_REGISTERED when the agent has no asset', async () => {
  const result = (await launchToken.execute!(
    {
      name: 'My Token',
      symbol: 'TOK',
      imageUri: IMAGE_URI,
      confirmIrreversible: true,
    },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: null,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'NOT_REGISTERED');
  assert.match(result.message, /must be registered first/);
});

test('launch-token returns info short-circuit when agentTokenMint is already set', async () => {
  const result = (await launchToken.execute!(
    {
      name: 'My Token',
      symbol: 'TOK',
      imageUri: IMAGE_URI,
      confirmIrreversible: true,
    },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
        agentTokenMint: EXISTING_MINT,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'info');
  assert.equal(result.mintAddress, EXISTING_MINT);
  assert.match(result.message, /already has a token/);
});

test('launch-token returns info short-circuit when TOKEN_OVERRIDE is configured', async () => {
  const result = (await launchToken.execute!(
    {
      name: 'My Token',
      symbol: 'TOK',
      imageUri: IMAGE_URI,
      confirmIrreversible: true,
    },
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
        tokenOverride: EXISTING_MINT,
      }),
    } as any,
  )) as any;

  assert.equal(result.status, 'info');
  assert.equal(result.mintAddress, EXISTING_MINT);
  assert.match(result.message, /TOKEN_OVERRIDE is set/);
});

test('launch-token rejects non-URL imageUri via Zod', async () => {
  const result = (await launchToken.execute!(
    {
      name: 'My Token',
      symbol: 'TOK',
      imageUri: 'not-a-url',
      confirmIrreversible: true,
    } as any,
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
      }),
    } as any,
  )) as any;

  assert.equal(result.error, true);
});

test('launch-token rejects oversize symbol via Zod (>10 chars)', async () => {
  const result = (await launchToken.execute!(
    {
      name: 'My Token',
      symbol: 'TOOLONGTOK', // 10 - OK; bump above
      imageUri: IMAGE_URI,
      confirmIrreversible: true,
    } as any,
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
        agentTokenMint: EXISTING_MINT, // short-circuit to info so we don't run Genesis
      }),
    } as any,
  )) as any;

  // Exactly 10 chars is allowed -> info short-circuit fires.
  assert.equal(result.status, 'info');

  const overflow = (await launchToken.execute!(
    {
      name: 'My Token',
      symbol: 'WAYTOOLONGTOK', // 13
      imageUri: IMAGE_URI,
      confirmIrreversible: true,
    } as any,
    {
      requestContext: fakeContext({
        agentMode: 'autonomous',
        agentAssetAddress: AGENT_ASSET,
        agentTokenMint: EXISTING_MINT,
      }),
    } as any,
  )) as any;

  assert.equal(overflow.error, true);
});
