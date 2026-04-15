import { Agent } from '@mastra/core/agent';
import { getConfig } from '@metaplex-agent/shared';
import { autonomousAgentTools } from './tools/index.js';
import { buildSystemPrompt } from './prompts.js';

export function createAutonomousAgent() {
  const config = getConfig();

  return new Agent({
    id: 'metaplex-agent-autonomous',
    name: config.ASSISTANT_NAME,
    instructions: buildSystemPrompt('autonomous'),
    model: config.LLM_MODEL,
    tools: autonomousAgentTools,
  });
}
