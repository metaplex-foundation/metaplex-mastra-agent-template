import { Agent } from '@mastra/core/agent';
import { getConfig } from '@metaplex-agent/shared';
import { publicAgentTools } from './tools/index.js';
import { buildSystemPrompt } from './prompts.js';
import { personas } from './personas/index.js';

export function createPublicAgent() {
  const config = getConfig();
  const personaName = config.AGENT_PERSONA;
  if (personaName && !(personaName in personas)) {
    // Unknown persona — log so the operator sees the typo, but proceed
    // with the default persona rather than crashing the agent on boot.
    console.warn(
      `[agent] unknown AGENT_PERSONA="${personaName}"; falling back to "default". ` +
      `Bundled personas: ${Object.keys(personas).join(', ')}.`,
    );
  }

  return new Agent({
    id: 'metaplex-agent-public',
    name: config.ASSISTANT_NAME,
    instructions: buildSystemPrompt('public', personaName),
    model: config.LLM_MODEL,
    tools: publicAgentTools,
  });
}
