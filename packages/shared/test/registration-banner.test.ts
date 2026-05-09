import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildRegistrationBanner } from '../src/registration-banner.js';

test('banner contains the envKey=address line for copy-paste', () => {
  const banner = buildRegistrationBanner({
    kind: 'agent',
    address: 'AbC1234567890123456789012345678901234567890',
    envKey: 'AGENT_ASSET_ADDRESS',
    paas: { platform: 'unknown', label: 'local', instructions: '' },
  });
  assert.match(banner, /AGENT_ASSET_ADDRESS=AbC1234567890123456789012345678901234567890/);
});

test('agent banner uses friendly "registered" wording', () => {
  const banner = buildRegistrationBanner({
    kind: 'agent',
    address: 'AbC1234567890123456789012345678901234567890',
    envKey: 'AGENT_ASSET_ADDRESS',
    paas: { platform: 'unknown', label: 'local', instructions: '' },
  });
  assert.match(banner, /registered|agent identity/i);
});

test('token banner uses friendly "launched" wording', () => {
  const banner = buildRegistrationBanner({
    kind: 'token',
    address: 'TkN1234567890123456789012345678901234567890',
    envKey: 'AGENT_TOKEN_MINT',
    paas: { platform: 'unknown', label: 'local', instructions: '' },
  });
  assert.match(banner, /token|launched|mint/i);
  assert.match(banner, /AGENT_TOKEN_MINT=TkN1234567890123456789012345678901234567890/);
});

test('banner inlines PaaS instructions when present', () => {
  const banner = buildRegistrationBanner({
    kind: 'agent',
    address: 'AbC1234567890123456789012345678901234567890',
    envKey: 'AGENT_ASSET_ADDRESS',
    paas: {
      platform: 'railway',
      label: 'Railway',
      instructions: 'Set this in Variables → Add Variable. Otherwise the next redeploy loses identity.',
    },
  });
  assert.match(banner, /Railway/);
  assert.match(banner, /Variables.*Add Variable/);
});

test('banner emits a visible warning about ephemeral state', () => {
  const banner = buildRegistrationBanner({
    kind: 'agent',
    address: 'AbC1234567890123456789012345678901234567890',
    envKey: 'AGENT_ASSET_ADDRESS',
    paas: { platform: 'unknown', label: 'local', instructions: '' },
  });
  // Operators should see something attention-grabbing about persistence,
  // not a polite info note that gets lost in the log.
  assert.match(banner, /IMPORTANT|ACTION REQUIRED|⚠|WARNING/i);
});
