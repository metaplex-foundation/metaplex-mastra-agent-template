import { test, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadAgentConfigFile,
  agentConfigToEnvDefaults,
  applyAgentConfigToEnv,
} from '../../src/agent-config.js';

const tmpFiles: string[] = [];

function makeTmpYaml(content: string): string {
  const path = join(tmpdir(), `agent-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(path, content);
  tmpFiles.push(path);
  return path;
}

afterEach(() => {
  for (const f of tmpFiles) {
    if (existsSync(f)) unlinkSync(f);
  }
  tmpFiles.length = 0;
});

test('loadAgentConfigFile returns null when file does not exist', () => {
  const result = loadAgentConfigFile('/nonexistent/path/to/config.yaml');
  assert.equal(result, null);
});

test('loadAgentConfigFile parses a minimal YAML file', () => {
  const path = makeTmpYaml('agent_name: My Bot\npersona: token-launch-concierge\n');
  const result = loadAgentConfigFile(path);
  assert.deepEqual(result, {
    agent_name: 'My Bot',
    persona: 'token-launch-concierge',
  });
});

test('loadAgentConfigFile parses nested worker and limits', () => {
  const yaml = `
agent_name: Treasury Bot
worker:
  interval_ms: 60000
  dry_run: false
  max_tx_per_tick: 5
limits:
  max_slippage_bps: 250
  max_price_impact_pct: 1.5
`;
  const path = makeTmpYaml(yaml);
  const result = loadAgentConfigFile(path);
  assert.deepEqual(result, {
    agent_name: 'Treasury Bot',
    worker: {
      interval_ms: 60000,
      dry_run: false,
      max_tx_per_tick: 5,
    },
    limits: {
      max_slippage_bps: 250,
      max_price_impact_pct: 1.5,
    },
  });
});

test('loadAgentConfigFile rejects malformed YAML by throwing a friendly error', () => {
  const path = makeTmpYaml('agent_name: \n  - not a mapping');
  assert.throws(() => loadAgentConfigFile(path), /agent.config.yaml/);
});

test('loadAgentConfigFile rejects unknown top-level keys with a clear error', () => {
  const path = makeTmpYaml('agent_name: Bot\nunknown_field: value\n');
  assert.throws(() => loadAgentConfigFile(path), /unknown_field/);
});

test('agentConfigToEnvDefaults maps known fields to env var names', () => {
  const env = agentConfigToEnvDefaults({
    agent_name: 'My Bot',
    persona: 'token-launch-concierge',
    worker: {
      interval_ms: 60000,
      dry_run: false,
      max_tx_per_tick: 5,
    },
    limits: {
      max_slippage_bps: 250,
      max_price_impact_pct: 1.5,
    },
  });
  assert.equal(env.ASSISTANT_NAME, 'My Bot');
  assert.equal(env.AGENT_PERSONA, 'token-launch-concierge');
  assert.equal(env.TICK_INTERVAL_MS, '60000');
  assert.equal(env.AUTONOMOUS_DRY_RUN, 'false');
  assert.equal(env.MAX_TICK_TX_COUNT, '5');
  assert.equal(env.MAX_SLIPPAGE_BPS, '250');
  assert.equal(env.MAX_PRICE_IMPACT_PCT, '1.5');
});

test('agentConfigToEnvDefaults omits unset fields rather than emitting empty strings', () => {
  const env = agentConfigToEnvDefaults({ agent_name: 'Bot' });
  assert.equal(env.ASSISTANT_NAME, 'Bot');
  assert.equal('AGENT_PERSONA' in env, false);
  assert.equal('TICK_INTERVAL_MS' in env, false);
});

test('applyAgentConfigToEnv does NOT overwrite already-set env vars', () => {
  const target = { ASSISTANT_NAME: 'FromEnv' } as Record<string, string>;
  applyAgentConfigToEnv({ agent_name: 'FromYaml' }, target);
  assert.equal(target.ASSISTANT_NAME, 'FromEnv');
});

test('applyAgentConfigToEnv DOES set env vars that are missing', () => {
  const target = {} as Record<string, string>;
  applyAgentConfigToEnv({ agent_name: 'FromYaml', persona: 'wallet-cleanup-bot' }, target);
  assert.equal(target.ASSISTANT_NAME, 'FromYaml');
  assert.equal(target.AGENT_PERSONA, 'wallet-cleanup-bot');
});

test('applyAgentConfigToEnv treats empty-string env vars as unset (so YAML can fill them)', () => {
  // dotenv often emits empty strings for `KEY=` lines. Treating them as
  // present would block YAML defaults, which is the opposite of intent.
  const target = { ASSISTANT_NAME: '', AGENT_PERSONA: '' } as Record<string, string>;
  applyAgentConfigToEnv({ agent_name: 'FromYaml', persona: 'default' }, target);
  assert.equal(target.ASSISTANT_NAME, 'FromYaml');
  assert.equal(target.AGENT_PERSONA, 'default');
});

test('applyAgentConfigToEnv handles boolean dry_run via string conversion', () => {
  const target = {} as Record<string, string>;
  applyAgentConfigToEnv({ worker: { dry_run: false } }, target);
  assert.equal(target.AUTONOMOUS_DRY_RUN, 'false');
  // Boolean true must serialize to the string 'true' so the env-driven
  // schema (which preprocess()s string env values) sees it correctly.
  // Use a fresh target with an empty AUTONOMOUS_DRY_RUN slot so the
  // applyAgentConfigToEnv "empty == unset" rule lets the YAML default fill it.
  const target2 = { AUTONOMOUS_DRY_RUN: '' } as Record<string, string>;
  applyAgentConfigToEnv({ worker: { dry_run: true } }, target2);
  assert.equal(target2.AUTONOMOUS_DRY_RUN, 'true');
});
