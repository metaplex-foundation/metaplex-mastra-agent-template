import { Agent } from '@mastra/core/agent';
import { getConfig, getAgentConfigFile, resolveAgentModel } from '@metaplex-foundation/shared';
import {
  createToolset,
  publicBundle,
  type ToolDefinition,
} from '@metaplex-foundation/agent-tools';
import { buildSystemPrompt } from './prompts.js';
import { personas } from './personas/index.js';
import { delegateToNori } from './tools/delegate-to-nori.js';

export function createPublicAgent() {
  const config = getConfig();
  const toolsConfig = getAgentConfigFile()?.tools;
  // Operator-supplied `tools:` fully replaces the mode default — opting in
  // is all-or-nothing so behavior is predictable. Absent → keep the
  // historical publicBundle so existing forks see no change on upgrade.
  const baseTools = toolsConfig
    ? createToolset({
        include: toolsConfig.include,
        exclude: toolsConfig.exclude,
      })
    : publicBundle;
  // delegate-to-nori is only useful when PLUMBER_URL is set. We always
  // include it — the tool itself short-circuits with a clear message when
  // unset, which is friendlier than hiding it conditionally.
  // The widened `Record<string, ToolDefinition>` annotation keeps TS from
  // inferring a parameterized return type that references the agent-tools
  // ToolDefinition through a deep node_modules path (TS2883).
  const tools: Record<string, ToolDefinition> = {
    ...baseTools,
    'delegate-to-nori': delegateToNori,
  };
  const personaName = config.AGENT_PERSONA;
  // Use `Object.hasOwn` rather than the `in` operator so prototype-chain
  // keys (`toString`, `constructor`, …) can't masquerade as personas.
  const isKnownPersona = personaName ? Object.hasOwn(personas, personaName) : true;
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
    model: resolveAgentModel(),
    tools,
  });
}
