import { test, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  isolateEnv,
  restoreEnv,
  defaultTestEnv,
} from '../../../shared/test/helpers/env.js';
import { _resetConfigForTests } from '@metaplex-foundation/shared';
import { buildSystemPrompt } from '../../src/prompts.js';
import { personas, defaultPersona } from '../../src/personas/index.js';

/**
 * Integration tests for `buildSystemPrompt`.
 *
 * `buildSystemPrompt` doesn't itself call `getConfig()` today, but the
 * prompt-assembly flow (persona registry + mode addendum) is a load-bearing
 * piece of agent boot and is wired through env. We isolate the env per
 * test for symmetry with the rest of the integration suite and to guard
 * against future changes that might pull config in (e.g. flag gating an
 * addendum).
 */

afterEach(() => {
  restoreEnv();
  _resetConfigForTests();
});

// The first line of BASE_HEADER. Asserting on the entire header is brittle
// to wording tweaks; asserting on the first line keeps the test honest
// without coupling tightly to the prompt text.
const BASE_HEADER_PREFIX =
  'You are a Solana blockchain agent with your own on-chain identity and wallet.';

test('buildSystemPrompt(public) starts with the BASE_HEADER prefix', () => {
  isolateEnv(defaultTestEnv());
  const prompt = buildSystemPrompt('public');
  assert.ok(
    prompt.startsWith(BASE_HEADER_PREFIX),
    `public prompt should start with BASE_HEADER. Got: ${prompt.slice(0, 80)}`,
  );
});

test('buildSystemPrompt(autonomous) starts with the BASE_HEADER prefix', () => {
  isolateEnv(defaultTestEnv({ AGENT_MODE: 'autonomous' }));
  const prompt = buildSystemPrompt('autonomous');
  assert.ok(
    prompt.startsWith(BASE_HEADER_PREFIX),
    `autonomous prompt should start with BASE_HEADER. Got: ${prompt.slice(0, 80)}`,
  );
});

test('buildSystemPrompt(public) includes PUBLIC-mode language', () => {
  isolateEnv(defaultTestEnv());
  const prompt = buildSystemPrompt('public');
  // Distinctive public-mode phrases — UI signing, user wallet, fee mechanics.
  assert.match(prompt, /Transaction Mode: Public/);
  assert.match(prompt, /send it to their wallet for approval/i);
  assert.match(prompt, /transfer-sol and transfer-token tools/i);
});

test('buildSystemPrompt(public) excludes AUTONOMOUS-mode language', () => {
  isolateEnv(defaultTestEnv());
  const prompt = buildSystemPrompt('public');
  // Autonomous-only sections must not leak into the public prompt.
  assert.doesNotMatch(prompt, /Transaction Mode: Autonomous/);
  assert.doesNotMatch(prompt, /Working Memory: Goals, Tasks/);
  assert.doesNotMatch(prompt, /## Tick mode/);
  assert.doesNotMatch(prompt, /set-paused/);
  assert.doesNotMatch(prompt, /withdraw-sol/);
});

test('buildSystemPrompt(autonomous) includes AUTONOMOUS-mode language', () => {
  isolateEnv(defaultTestEnv({ AGENT_MODE: 'autonomous' }));
  const prompt = buildSystemPrompt('autonomous');
  // The autonomous addendum is what wires goals/tasks/journal + tick mode.
  assert.match(prompt, /Transaction Mode: Autonomous/);
  assert.match(prompt, /Working Memory: Goals, Tasks/);
  assert.match(prompt, /## Tick mode/);
  assert.match(prompt, /set-paused/);
  assert.match(prompt, /withdraw-sol/);
  // Journal + goals/tasks vocabulary.
  assert.match(prompt, /journal/i);
  assert.match(prompt, /add-task/);
  assert.match(prompt, /close-task/);
  assert.match(prompt, /set-goal/);
});

test('buildSystemPrompt(autonomous) excludes PUBLIC-only language', () => {
  isolateEnv(defaultTestEnv({ AGENT_MODE: 'autonomous' }));
  const prompt = buildSystemPrompt('autonomous');
  assert.doesNotMatch(prompt, /Transaction Mode: Public/);
});

test('buildSystemPrompt with persona injects the persona body verbatim', () => {
  isolateEnv(defaultTestEnv());
  const prompt = buildSystemPrompt('public', 'treasury-rebalancer');
  const persona = personas['treasury-rebalancer'];
  // The persona body lives between BASE_HEADER and the mode addendum.
  // Asserting a substring match is enough — full byte-identity is brittle
  // and the position is enforced by the prefix/suffix assertions in other
  // tests.
  assert.ok(
    prompt.includes(persona.body),
    'persona body should appear verbatim in the assembled prompt',
  );
});

test('buildSystemPrompt with persona keeps mode addendum intact', () => {
  isolateEnv(defaultTestEnv({ AGENT_MODE: 'autonomous' }));
  const prompt = buildSystemPrompt('autonomous', 'treasury-rebalancer');
  // Persona body present.
  assert.ok(prompt.includes(personas['treasury-rebalancer'].body));
  // Mode addendum still present — persona doesn't displace it.
  assert.match(prompt, /Transaction Mode: Autonomous/);
  assert.match(prompt, /Working Memory: Goals, Tasks/);
});

test('buildSystemPrompt with unknown persona falls back to default body', () => {
  isolateEnv(defaultTestEnv());
  const known = buildSystemPrompt('public');
  const unknown = buildSystemPrompt('public', 'this-persona-does-not-exist');
  // The fallback path in getPersona returns defaultPersona, so the two
  // built prompts must be byte-identical.
  assert.equal(unknown, known);
  // And the default body is in there.
  assert.ok(unknown.includes(defaultPersona.body));
});

test('buildSystemPrompt with null/undefined persona uses default', () => {
  isolateEnv(defaultTestEnv());
  const fromUndefined = buildSystemPrompt('public', undefined);
  const fromNull = buildSystemPrompt('public', null);
  const fromOmitted = buildSystemPrompt('public');
  assert.equal(fromUndefined, fromOmitted);
  assert.equal(fromNull, fromOmitted);
});

test('buildSystemPrompt produces different prompts per persona (sanity)', () => {
  isolateEnv(defaultTestEnv());
  const defaultPrompt = buildSystemPrompt('public');
  const conciergePrompt = buildSystemPrompt('public', 'token-launch-concierge');
  const cleanupPrompt = buildSystemPrompt('public', 'wallet-cleanup-bot');
  const treasuryPrompt = buildSystemPrompt('public', 'treasury-rebalancer');
  // All distinct — proves persona swap is wired.
  const set = new Set([defaultPrompt, conciergePrompt, cleanupPrompt, treasuryPrompt]);
  assert.equal(set.size, 4, 'each persona should produce a unique prompt');
});

test('buildSystemPrompt assembly order: header, persona body, mode addendum', () => {
  isolateEnv(defaultTestEnv());
  const prompt = buildSystemPrompt('public', 'treasury-rebalancer');
  const persona = personas['treasury-rebalancer'];
  const headerIdx = prompt.indexOf(BASE_HEADER_PREFIX);
  const personaIdx = prompt.indexOf(persona.body);
  const addendumIdx = prompt.indexOf('## Transaction Mode: Public');
  assert.equal(headerIdx, 0, 'BASE_HEADER must be at offset 0');
  assert.ok(personaIdx > headerIdx, 'persona body must come after header');
  assert.ok(
    addendumIdx > personaIdx,
    'mode addendum must come after persona body',
  );
});
