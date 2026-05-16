import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { buildSiwsMessage, verifySiwsSignature } from '../../src/siws.js';

test('buildSiwsMessage produces canonical multiline string', () => {
  const msg = buildSiwsMessage({
    agentName: 'Treasury Bot',
    agentAsset: 'ARsZN4kZUWNX8Ek5ZkVUpRitSFjym6p9jLvUxrg9kPWU',
    network: 'solana-mainnet',
    nonce: 'abc123',
    issuedAt: '2026-05-04T19:00:00.000Z',
    expiresAt: '2026-05-04T19:01:00.000Z',
  });
  assert.equal(
    msg,
    'Sign in to Treasury Bot\n' +
    '\n' +
    'Agent: ARsZN4kZUWNX8Ek5ZkVUpRitSFjym6p9jLvUxrg9kPWU\n' +
    'Network: solana-mainnet\n' +
    'Nonce: abc123\n' +
    'Issued: 2026-05-04T19:00:00.000Z\n' +
    'Expires: 2026-05-04T19:01:00.000Z',
  );
});

test('buildSiwsMessage uses "unregistered" when agentAsset is null', () => {
  const msg = buildSiwsMessage({
    agentName: 'Treasury Bot',
    agentAsset: null,
    network: 'solana-devnet',
    nonce: 'abc',
    issuedAt: 'x',
    expiresAt: 'y',
  });
  assert.match(msg, /^Sign in to Treasury Bot\n\nAgent: unregistered\n/);
});

test('verifySiwsSignature accepts a valid signature', () => {
  const kp = nacl.sign.keyPair();
  const message = 'hello world';
  const sigBytes = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
  const ok = verifySiwsSignature({
    message,
    signatureBase58: bs58.encode(sigBytes),
    publicKeyBase58: bs58.encode(kp.publicKey),
  });
  assert.equal(ok, true);
});

test('verifySiwsSignature rejects a tampered message', () => {
  const kp = nacl.sign.keyPair();
  const sig = nacl.sign.detached(new TextEncoder().encode('original'), kp.secretKey);
  const ok = verifySiwsSignature({
    message: 'tampered',
    signatureBase58: bs58.encode(sig),
    publicKeyBase58: bs58.encode(kp.publicKey),
  });
  assert.equal(ok, false);
});

test('verifySiwsSignature rejects malformed base58 inputs', () => {
  assert.equal(
    verifySiwsSignature({ message: 'x', signatureBase58: '!!!', publicKeyBase58: '!!!' }),
    false,
  );
});
