import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  getPersona,
  personas,
  personaNames,
  defaultPersona,
} from '../../src/personas/index.js';
import { buildSystemPrompt } from '../../src/prompts.js';

test('getPersona returns default for undefined input', () => {
  assert.equal(getPersona().name, 'default');
  assert.equal(getPersona(undefined).name, 'default');
  assert.equal(getPersona(null).name, 'default');
});

test('getPersona returns default for unknown slug', () => {
  assert.equal(getPersona('nonexistent-persona-zzz').name, 'default');
});

test('getPersona returns the requested persona by slug', () => {
  assert.equal(getPersona('token-launch-concierge').name, 'token-launch-concierge');
  assert.equal(getPersona('wallet-cleanup-bot').name, 'wallet-cleanup-bot');
});

test('personaNames includes all bundled personas', () => {
  const expected = [
    'default',
    'token-launch-concierge',
    'wallet-cleanup-bot',
    'treasury-rebalancer',
  ];
  for (const slug of expected) {
    assert.ok(personaNames.includes(slug), `${slug} missing from personaNames`);
    assert.ok(slug in personas, `${slug} missing from personas registry`);
  }
});

test('personaNames does not include personas without backing tools', () => {
  // portfolio-advisor and nft-mint-helper were dropped because the prompt
  // body promised behavior the toolset cannot enforce (a "read-only"
  // persona that still has swap tools available, or NFT lookup tools that
  // are actually SPL-token-focused). They wait on per-persona tool
  // filtering — see UX audit #4 "tool enable/disable" deferred work.
  assert.ok(!('portfolio-advisor' in personas));
  assert.ok(!('nft-mint-helper' in personas));
});

test('every persona has name, description, and body', () => {
  for (const persona of Object.values(personas)) {
    assert.ok(persona.name, 'persona missing name');
    assert.ok(persona.description.length > 20, `${persona.name} description too short`);
    assert.ok(persona.body.length > 100, `${persona.name} body too short`);
  }
});

test('persona slugs match their registry keys', () => {
  for (const [key, persona] of Object.entries(personas)) {
    assert.equal(persona.name, key, `mismatch: registry key=${key}, persona.name=${persona.name}`);
  }
});

test('buildSystemPrompt with default persona contains the bootstrap section', () => {
  const prompt = buildSystemPrompt('public');
  assert.match(prompt, /Bootstrap.*NOT Registered/i);
  assert.match(prompt, /Your Identity/);
  assert.match(prompt, /Tools Available/);
});

test('buildSystemPrompt(public) includes the public addendum, not autonomous', () => {
  const prompt = buildSystemPrompt('public');
  assert.match(prompt, /Transaction Mode: Public/);
  assert.doesNotMatch(prompt, /Transaction Mode: Autonomous/);
  assert.doesNotMatch(prompt, /Working Memory: Goals, Tasks/);
});

test('buildSystemPrompt(autonomous) includes the autonomous addendum, not public', () => {
  const prompt = buildSystemPrompt('autonomous');
  assert.match(prompt, /Transaction Mode: Autonomous/);
  assert.match(prompt, /Working Memory: Goals, Tasks/);
  assert.doesNotMatch(prompt, /Transaction Mode: Public/);
});

test('buildSystemPrompt swaps the body when a non-default persona is requested', () => {
  const def = buildSystemPrompt('public');
  const concierge = buildSystemPrompt('public', 'token-launch-concierge');
  assert.notEqual(def, concierge);
  // Default persona body has "Token Launch" section title; concierge has "Launch Flow".
  assert.match(concierge, /Launch Flow/);
  assert.match(concierge, /token-launch concierge/i);
});

test('buildSystemPrompt falls back to default for unknown persona', () => {
  const def = buildSystemPrompt('public');
  const unknown = buildSystemPrompt('public', 'this-does-not-exist');
  assert.equal(def, unknown);
});

test('default persona body matches the default persona definition', () => {
  // Sanity: the default persona's body shows up in the built prompt.
  const prompt = buildSystemPrompt('public');
  // Sample a distinctive line from the default body.
  const sample = defaultPersona.body.split('\n').find((l) => l.startsWith('## Token Launch'));
  assert.ok(sample, 'default persona missing expected section header');
  assert.ok(prompt.includes(sample), 'default persona body not included in prompt');
});
