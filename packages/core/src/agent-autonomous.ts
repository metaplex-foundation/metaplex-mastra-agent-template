import { Agent } from '@mastra/core/agent';
import { getConfig } from '@metaplex-agent/shared';
import { autonomousAgentTools } from './tools/index.js';
import { buildSystemPrompt } from './prompts.js';
import { personas } from './personas/index.js';

export function createAutonomousAgent() {
  const config = getConfig();
  const personaName = config.AGENT_PERSONA;
  if (personaName && !(personaName in personas)) {
    console.warn(
      `[agent] unknown AGENT_PERSONA="${personaName}"; falling back to "default". ` +
      `Bundled personas: ${Object.keys(personas).join(', ')}.`,
    );
  }

  return new Agent({
    id: 'metaplex-agent-autonomous',
    name: config.ASSISTANT_NAME,
    instructions: buildSystemPrompt('autonomous', personaName),
    model: config.LLM_MODEL,
    tools: autonomousAgentTools,
  });
}
