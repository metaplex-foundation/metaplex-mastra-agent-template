import { Agent } from '@mastra/core/agent';
import { getConfig, getAgentConfigFile, resolveAgentModel } from '@metaplex-foundation/shared';
import {
  autonomousBundle,
  createToolset,
  type ToolDefinition,
} from '@metaplex-foundation/agent-tools';
import { delegateToNori } from './tools/delegate-to-nori.js';
import { buildSystemPrompt } from './prompts.js';
import { personas } from './personas/index.js';

export function createAutonomousAgent() {
  const config = getConfig();
  const toolsConfig = getAgentConfigFile()?.tools;
  // See agent-public.ts — same pattern. Autonomous mode default keeps the
  // working-memory tools (goals/tasks/paused) that public mode doesn't get.
  const baseTools = toolsConfig
    ? createToolset({
        include: toolsConfig.include,
        exclude: toolsConfig.exclude,
      })
    : autonomousBundle;
  const tools: Record<string, ToolDefinition> = {
    ...baseTools,
    'delegate-to-nori': delegateToNori,
  };
  const personaName = config.AGENT_PERSONA;
  // Use `Object.hasOwn` rather than the `in` operator so prototype-chain
  // keys (`toString`, `constructor`, …) can't masquerade as personas.
  const isKnownPersona = personaName ? Object.hasOwn(personas, personaName) : true;
  if (personaName && !isKnownPersona) {
    console.warn(
      `[agent] unknown AGENT_PERSONA="${personaName}"; falling back to "default". ` +
      `Bundled personas: ${Object.keys(personas).join(', ')}.`,
    );
  }
  const normalizedPersona = isKnownPersona ? personaName : undefined;

  return new Agent({
    id: 'metaplex-agent-autonomous',
    name: config.ASSISTANT_NAME,
    instructions: buildSystemPrompt('autonomous', normalizedPersona),
    model: resolveAgentModel(),
    tools,
  });
}
