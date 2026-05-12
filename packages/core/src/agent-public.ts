import { Agent } from '@mastra/core/agent';
import { getConfig } from '@metaplex-agent/shared';
import { publicAgentTools } from './tools/index.js';
import { buildSystemPrompt } from './prompts.js';
import { personas } from './personas/index.js';

export function createPublicAgent() {
  const config = getConfig();
  const personaName = config.AGENT_PERSONA;
  const isKnownPersona = personaName ? personaName in personas : true;
  if (personaName && !isKnownPersona) {
    // Unknown persona — log so the operator sees the typo, but proceed
    // with the default persona rather than crashing the agent on boot.
    console.warn(
      `[agent] unknown AGENT_PERSONA="${personaName}"; falling back to "default". ` +
      `Bundled personas: ${Object.keys(personas).join(', ')}.`,
    );
  }
  // Normalize unknown values to undefined so downstream code doesn't have
  // to repeat the fallback logic. buildSystemPrompt's getPersona() also
  // tolerates unknown names, but explicit normalization here keeps the
  // contract clear and avoids relying on the downstream fallback.
  const normalizedPersona = isKnownPersona ? personaName : undefined;

  return new Agent({
    id: 'metaplex-agent-public',
    name: config.ASSISTANT_NAME,
    instructions: buildSystemPrompt('public', normalizedPersona),
    model: config.LLM_MODEL,
    tools: publicAgentTools,
  });
}
