export type ScriptedStep =
  | { type: 'tool-call'; toolName: string; args: unknown }
  | { type: 'text'; content: string };

export interface ToolEntry {
  execute: (args: unknown, ctx: { requestContext: unknown }) => Promise<unknown>;
}

export interface StubAgent {
  generate: (input: unknown, opts?: { requestContext?: unknown }) => Promise<{
    text: string;
    toolCalls: { toolName: string; args: unknown; result: unknown }[];
  }>;
  setScript: (steps: ScriptedStep[]) => void;
  toolResults: Map<string, unknown>;
}

export function makeStubAgent(tools: Record<string, ToolEntry>): StubAgent {
  let script: ScriptedStep[] = [];
  const toolResults = new Map<string, unknown>();

  return {
    generate: async (_input, opts) => {
      const ctx = opts?.requestContext;
      const toolCalls: { toolName: string; args: unknown; result: unknown }[] = [];
      let text = '';
      for (const step of script) {
        if (step.type === 'text') {
          text += step.content;
        } else {
          const tool = tools[step.toolName];
          if (!tool) throw new Error(`stub agent: tool ${step.toolName} not registered`);
          const result = await tool.execute(step.args, { requestContext: ctx });
          toolCalls.push({ toolName: step.toolName, args: step.args, result });
          toolResults.set(step.toolName, result);
        }
      }
      return { text, toolCalls };
    },
    setScript(steps) { script = steps; },
    toolResults,
  };
}
