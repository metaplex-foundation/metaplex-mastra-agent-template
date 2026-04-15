import { getConfig } from '@metaplex-agent/shared';
import { createPublicAgent } from './agent-public.js';
import { createAutonomousAgent } from './agent-autonomous.js';

export function createAgent() {
  const config = getConfig();
  if (config.AGENT_MODE === 'autonomous') {
    return createAutonomousAgent();
  }
  return createPublicAgent();
}
