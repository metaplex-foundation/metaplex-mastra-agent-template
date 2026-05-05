import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildSiwsMessage } from '../src/siws.js';

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
