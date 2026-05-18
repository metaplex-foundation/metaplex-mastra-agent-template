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

// --- Persona module load smoke ----------------------------------------
//
// Each bundled persona file should be importable on its own. This guards
// against a future regression where a persona file accidentally introduces
// a top-level side effect (env read, fs touch) that breaks isolated
// loading. Dynamic imports keep the test honest — bundlers can't tree-
// shake them away.

const BUNDLED_PERSONA_FILES = [
  'default',
  'token-launch-concierge',
  'wallet-cleanup-bot',
  'treasury-rebalancer',
] as const;

for (const slug of BUNDLED_PERSONA_FILES) {
  test(`persona file "${slug}" loads without error and exports a valid Persona`, async () => {
    // Dynamic import — tsx resolves the .js suffix to the .ts source at
    // test time.
    const mod = await import(`../../src/personas/${slug}.js`);
    const persona =
      mod.default ??
      mod.defaultPersona ??
      mod.tokenLaunchConcierge ??
      mod.walletCleanupBot ??
      mod.treasuryRebalancer ??
      Object.values(mod).find(
        (v): v is { name: string; description: string; body: string } =>
          typeof v === 'object' && v !== null && 'body' in (v as object),
      );
    assert.ok(persona, `persona file ${slug} did not export a Persona-shaped value`);
    assert.equal(
      typeof (persona as { name: unknown }).name,
      'string',
      `${slug}.name must be a string`,
    );
    assert.ok(
      (persona as { name: string }).name.length > 0,
      `${slug}.name must be non-empty`,
    );
    assert.equal(
      typeof (persona as { description: unknown }).description,
      'string',
      `${slug}.description must be a string`,
    );
    assert.equal(
      typeof (persona as { body: unknown }).body,
      'string',
      `${slug}.body must be a string`,
    );
    assert.ok(
      (persona as { body: string }).body.length > 0,
      `${slug}.body must be non-empty`,
    );
  });
}

test('every persona body is a non-empty string with substantive content', () => {
  for (const [slug, persona] of Object.entries(personas)) {
    assert.equal(typeof persona.body, 'string', `${slug}.body must be a string`);
    assert.ok(persona.body.trim().length > 0, `${slug}.body must be non-empty`);
    // Substantive content threshold — guards against accidentally
    // shipping a one-line stub.
    assert.ok(persona.body.length > 100, `${slug}.body looks too short (${persona.body.length} chars)`);
  }
});

test('getPersona fallback to default is byte-identical to the explicit default', () => {
  // The contract: an unknown slug must produce the *same* persona object
  // as the default, not a fresh-but-equivalent one. This matters because
  // downstream code (logging, comparisons) may rely on reference equality.
  const explicit = getPersona('default');
  const fallback = getPersona('completely-unknown-slug-xyz');
  assert.equal(fallback, explicit, 'fallback should return the same default reference');
  assert.equal(fallback.name, 'default');
});

test('every persona in the registry can be retrieved by its slug', () => {
  // Round-trip every registered persona through getPersona to prove the
  // registry's keys match the slugs the resolver expects.
  for (const slug of Object.keys(personas)) {
    const resolved = getPersona(slug);
    assert.equal(resolved.name, slug, `getPersona("${slug}") returned wrong persona`);
  }
});
