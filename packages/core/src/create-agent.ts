import type { Agent } from '@mastra/core/agent';
import { getConfig } from '@metaplex-foundation/shared';
import { createPublicAgent } from './agent-public.js';
import { createAutonomousAgent } from './agent-autonomous.js';

// Explicit return type — without it, TS2883 fires because the inferred
// Agent<...> generic references ToolDefinition through agent-tools'
// node_modules path, which isn't portable across workspace packages.
export function createAgent(): Agent {
  const config = getConfig();
  if (config.AGENT_MODE === 'autonomous') {
    return createAutonomousAgent();
  }
  return createPublicAgent();
}
