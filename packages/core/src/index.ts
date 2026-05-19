export { createAgent } from './create-agent.js';
export { createPublicAgent } from './agent-public.js';
export { createAutonomousAgent } from './agent-autonomous.js';

// Tool bundles now come from the toolkit. Re-export under the historical
// names so consumers of `@metaplex-foundation/core` (e.g. server, scripts)
// don't have to change their imports.
import {
  publicBundle as _publicBundle,
  autonomousBundle as _autonomousBundle,
} from '@metaplex-foundation/agent-tools';
export const publicAgentTools = _publicBundle;
export const autonomousAgentTools = _autonomousBundle;
export const publicToolNames = Object.keys(_publicBundle);
export const autonomousToolNames = Object.keys(_autonomousBundle);

export {
  personas,
  personaNames,
  getPersona,
  defaultPersona,
  tokenLaunchConcierge,
  walletCleanupBot,
  treasuryRebalancer,
  type Persona,
} from './personas/index.js';
export { buildSystemPrompt } from './prompts.js';
