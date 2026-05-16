import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  publicAgentTools,
  autonomousAgentTools,
  publicToolNames,
  autonomousToolNames,
} from '../../src/tools/index.js';

const EXPECTED_PUBLIC = [
  'buybackToken',
  'delegateExecution',
  'fundAgentSol',
  'getBalance',
  'getTokenBalances',
  'getTokenMetadata',
  'getTokenPrice',
  'getTransaction',
  'launchToken',
  'registerAgent',
  'sellToken',
  'sleep',
  'swapToken',
  'transferSol',
  'transferToken',
];

const EXPECTED_AUTONOMOUS = [
  'addTask',
  'buybackToken',
  'closeGoal',
  'closeTask',
  'delegateExecution',
  'fundAgentSol',
  'getBalance',
  'getTokenBalances',
  'getTokenMetadata',
  'getTokenPrice',
  'getTransaction',
  'launchToken',
  'registerAgent',
  'sellToken',
  'setGoal',
  'setPaused',
  'sleep',
  'swapToken',
  'withdrawSol',
];

test('publicAgentTools exposes the expected stable surface', () => {
  assert.deepEqual(Object.keys(publicAgentTools).sort(), EXPECTED_PUBLIC);
});

test('autonomousAgentTools exposes the expected stable surface', () => {
  assert.deepEqual(Object.keys(autonomousAgentTools).sort(), EXPECTED_AUTONOMOUS);
});

test('publicAgentTools does not leak autonomous-only tools', () => {
  const autonomousOnly = ['setGoal', 'closeGoal', 'addTask', 'closeTask', 'setPaused', 'withdrawSol'];
  for (const banned of autonomousOnly) {
    assert.equal(
      banned in publicAgentTools,
      false,
      `${banned} must not be in publicAgentTools (autonomous-only)`,
    );
  }
});

test('autonomousAgentTools does not leak public-only transfer tools', () => {
  const publicOnly = ['transferSol', 'transferToken'];
  for (const banned of publicOnly) {
    assert.equal(
      banned in autonomousAgentTools,
      false,
      `${banned} must not be in autonomousAgentTools (public-only)`,
    );
  }
});

test('publicToolNames and autonomousToolNames mirror the keys', () => {
  assert.deepEqual([...publicToolNames].sort(), EXPECTED_PUBLIC);
  assert.deepEqual([...autonomousToolNames].sort(), EXPECTED_AUTONOMOUS);
});

test('every registered tool has an execute function', () => {
  for (const [name, tool] of Object.entries(publicAgentTools)) {
    assert.equal(typeof (tool as { execute?: unknown }).execute, 'function', `publicAgentTools.${name}.execute must be a function`);
  }
  for (const [name, tool] of Object.entries(autonomousAgentTools)) {
    assert.equal(typeof (tool as { execute?: unknown }).execute, 'function', `autonomousAgentTools.${name}.execute must be a function`);
  }
});
