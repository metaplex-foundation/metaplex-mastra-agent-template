import { test, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import nacl from 'tweetnacl';
import {
  isolateEnv,
  restoreEnv,
  defaultTestEnv,
} from '../../../shared/test/helpers/env.js';
import { _resetConfigForTests } from '@metaplex-foundation/shared';
import { createAgent } from '../../src/create-agent.js';
import {
  publicAgentTools,
  autonomousAgentTools,
} from '../../src/tools/index.js';

/**
 * Integration tests for `createAgent()` mode dispatch.
 *
 * We never call `agent.generate()` here — that would hit the real
 * Anthropic API. We only inspect the assembled agent's shape (id, name,
 * tool surface) to prove the right factory was picked and the right
 * toolset was wired in.
 *
 * The autonomous-mode pre-registration gate in `getConfig()` requires
 * either AGENT_ASSET_ADDRESS or BOOTSTRAP_WALLET — without one of those
 * the config throws before we get to create-agent. We supply
 * BOOTSTRAP_WALLET in the autonomous tests.
 */

// A real Ed25519 secret key — the zero-keypair fixture used elsewhere
// fails validation when umi-bundle-defaults touches it. Generating once
// per module keeps the surface small.
const AGENT_KEYPAIR = JSON.stringify(Array.from(nacl.sign.keyPair().secretKey));
const VALID_BOOTSTRAP = 'AS3yQUgPgsEctYHJ8gJ5xZyL2Nq7kJZ5dq8Hh6BvjMq2';

afterEach(() => {
  restoreEnv();
  _resetConfigForTests();
});

// --- Helper -----------------------------------------------------------

async function listToolNames(agent: { listTools: (...args: any[]) => any }): Promise<string[]> {
  const tools = await agent.listTools();
  return Object.keys(tools).sort();
}

// --- Public mode ------------------------------------------------------

test('createAgent (AGENT_MODE=public) returns an agent with the public toolset', async () => {
  isolateEnv(defaultTestEnv({ AGENT_KEYPAIR }));
  const agent = createAgent();
  const names = await listToolNames(agent);
  // Public toolset = sharedTools + publicTools.
  assert.deepEqual(names, Object.keys(publicAgentTools).sort());
});

test('public-mode agent includes transfer-sol and transfer-token', async () => {
  isolateEnv(defaultTestEnv({ AGENT_KEYPAIR }));
  const agent = createAgent();
  const names = await listToolNames(agent);
  assert.ok(names.includes('transferSol'), 'transferSol must be in public toolset');
  assert.ok(names.includes('transferToken'), 'transferToken must be in public toolset');
});

test('public-mode agent excludes autonomous-only tools', async () => {
  isolateEnv(defaultTestEnv({ AGENT_KEYPAIR }));
  const agent = createAgent();
  const names = await listToolNames(agent);
  const autonomousOnly = ['setGoal', 'closeGoal', 'addTask', 'closeTask', 'setPaused', 'withdrawSol'];
  for (const banned of autonomousOnly) {
    assert.ok(
      !names.includes(banned),
      `public-mode agent must not expose ${banned}`,
    );
  }
});

test('public-mode agent has id "metaplex-agent-public"', () => {
  isolateEnv(defaultTestEnv({ AGENT_KEYPAIR }));
  const agent = createAgent();
  assert.equal(agent.id, 'metaplex-agent-public');
});

test('public-mode agent.name follows ASSISTANT_NAME env (default "Agent")', () => {
  isolateEnv(defaultTestEnv({ AGENT_KEYPAIR }));
  const agent = createAgent();
  // Default ASSISTANT_NAME is "Agent" per the zod schema default.
  assert.equal(agent.name, 'Agent');
});

test('public-mode agent.name reflects custom ASSISTANT_NAME', () => {
  isolateEnv(defaultTestEnv({ AGENT_KEYPAIR, ASSISTANT_NAME: 'TestyBot' }));
  const agent = createAgent();
  assert.equal(agent.name, 'TestyBot');
});

// --- Autonomous mode --------------------------------------------------

test('createAgent (AGENT_MODE=autonomous) returns an agent with the autonomous toolset', async () => {
  isolateEnv(
    defaultTestEnv({
      AGENT_MODE: 'autonomous',
      AGENT_KEYPAIR,
      BOOTSTRAP_WALLET: VALID_BOOTSTRAP,
    }),
  );
  const agent = createAgent();
  const names = await listToolNames(agent);
  assert.deepEqual(names, Object.keys(autonomousAgentTools).sort());
});

test('autonomous-mode agent includes setGoal, addTask, withdrawSol, setPaused', async () => {
  isolateEnv(
    defaultTestEnv({
      AGENT_MODE: 'autonomous',
      AGENT_KEYPAIR,
      BOOTSTRAP_WALLET: VALID_BOOTSTRAP,
    }),
  );
  const agent = createAgent();
  const names = await listToolNames(agent);
  for (const required of ['setGoal', 'addTask', 'closeTask', 'closeGoal', 'setPaused', 'withdrawSol']) {
    assert.ok(names.includes(required), `autonomous-mode agent must expose ${required}`);
  }
});

test('autonomous-mode agent excludes public-only transfer tools', async () => {
  isolateEnv(
    defaultTestEnv({
      AGENT_MODE: 'autonomous',
      AGENT_KEYPAIR,
      BOOTSTRAP_WALLET: VALID_BOOTSTRAP,
    }),
  );
  const agent = createAgent();
  const names = await listToolNames(agent);
  for (const banned of ['transferSol', 'transferToken']) {
    assert.ok(
      !names.includes(banned),
      `autonomous-mode agent must not expose ${banned}`,
    );
  }
});

test('autonomous-mode agent has id "metaplex-agent-autonomous"', () => {
  isolateEnv(
    defaultTestEnv({
      AGENT_MODE: 'autonomous',
      AGENT_KEYPAIR,
      BOOTSTRAP_WALLET: VALID_BOOTSTRAP,
    }),
  );
  const agent = createAgent();
  assert.equal(agent.id, 'metaplex-agent-autonomous');
});

test('autonomous-mode agent.name reflects ASSISTANT_NAME', () => {
  isolateEnv(
    defaultTestEnv({
      AGENT_MODE: 'autonomous',
      AGENT_KEYPAIR,
      BOOTSTRAP_WALLET: VALID_BOOTSTRAP,
      ASSISTANT_NAME: 'AutoBot',
    }),
  );
  const agent = createAgent();
  assert.equal(agent.name, 'AutoBot');
});

// --- Invalid mode -----------------------------------------------------

test('createAgent throws when AGENT_MODE is invalid', () => {
  isolateEnv(defaultTestEnv({ AGENT_KEYPAIR, AGENT_MODE: 'definitely-not-a-mode' }));
  // Zod schema enforces enum(['public', 'autonomous']); invalid values
  // bubble out of `getConfig()` as a thrown validation error, which
  // surfaces through `createAgent`.
  assert.throws(
    () => createAgent(),
    /AGENT_MODE|Invalid environment configuration/,
  );
});

// --- Persona handling --------------------------------------------------

test('createAgent with unknown AGENT_PERSONA still constructs (warning logged, default used)', () => {
  // Stub console.warn so the warning doesn't pollute test output, and so
  // we can assert it fired.
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    isolateEnv(
      defaultTestEnv({ AGENT_KEYPAIR, AGENT_PERSONA: 'this-is-not-a-real-persona' }),
    );
    const agent = createAgent();
    assert.ok(agent);
    assert.equal(agent.id, 'metaplex-agent-public');
    assert.ok(
      warnings.some((w) => /unknown AGENT_PERSONA/i.test(w)),
      `expected a warning about unknown AGENT_PERSONA; got: ${warnings.join(' | ')}`,
    );
  } finally {
    console.warn = originalWarn;
  }
});
