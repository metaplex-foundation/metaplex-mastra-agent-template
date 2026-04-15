import { Agent } from '@mastra/core/agent';
import { getConfig } from '@metaplex-agent/shared';
import { publicAgentTools } from './tools/index.js';
import { buildSystemPrompt } from './prompts.js';

export function createPublicAgent() {
  const config = getConfig();

  return new Agent({
    id: 'metaplex-agent-public',
    name: config.ASSISTANT_NAME,
    instructions: buildSystemPrompt('public'),
    model: config.LLM_MODEL,
    tools: publicAgentTools,
  });
}
