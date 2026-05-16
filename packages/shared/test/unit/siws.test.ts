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

test('buildSiwsMessage handles empty agentName with an empty name slot', () => {
  const msg = buildSiwsMessage({
    agentName: '',
    agentAsset: null,
    network: 'solana-devnet',
    nonce: 'n',
    issuedAt: 'i',
    expiresAt: 'e',
  });
  // The "Sign in to " prefix is preserved verbatim; the name slot is empty, so
  // the message begins with "Sign in to \n\n" (trailing space before newline).
  assert.equal(msg.startsWith('Sign in to \n\n'), true);
});

test('buildSiwsMessage preserves unicode bytes in agentName exactly', () => {
  // Guard against any future NFC/NFKC normalization slipping into the builder.
  // The bytes the wallet signs MUST be byte-identical to what the server
  // verifies — normalization would silently break verification.
  const name = 'Treasury 中文 🤖';
  const msg = buildSiwsMessage({
    agentName: name,
    agentAsset: null,
    network: 'solana-devnet',
    nonce: 'n',
    issuedAt: 'i',
    expiresAt: 'e',
  });
  const expected =
    `Sign in to ${name}\n` +
    '\n' +
    'Agent: unregistered\n' +
    'Network: solana-devnet\n' +
    'Nonce: n\n' +
    'Issued: i\n' +
    'Expires: e';
  assert.equal(msg, expected);
  // Belt-and-suspenders: encoded byte length must match the raw template, with
  // no normalization shrinkage.
  assert.equal(
    new TextEncoder().encode(msg).length,
    new TextEncoder().encode(expected).length,
  );
});

test('buildSiwsMessage embeds a newline in nonce literally (current behavior)', () => {
  // The current implementation does NOT reject embedded newlines in nonce.
  // This test pins that behavior so any future hardening that rejects/escapes
  // newlines fails loudly and forces an intentional update. See report:
  // design concern flagged.
  const msg = buildSiwsMessage({
    agentName: 'Bot',
    agentAsset: null,
    network: 'solana-devnet',
    nonce: 'abc\ndef',
    issuedAt: 'i',
    expiresAt: 'e',
  });
  assert.equal(
    msg,
    'Sign in to Bot\n' +
    '\n' +
    'Agent: unregistered\n' +
    'Network: solana-devnet\n' +
    'Nonce: abc\ndef\n' +
    'Issued: i\n' +
    'Expires: e',
  );
});
