import { z } from 'zod';

// ---------------------------------------------------------------------------
// Server-lifecycle / budget env vars
// ---------------------------------------------------------------------------
// These live in a separate helper so Workstream D's additions don't collide
// with Workstream A's changes to `config.ts`. They're read lazily and cached.
//
//   AGENT_FUNDING_SOL               — amount of SOL to top up the agent keypair
//                                     during public-mode registration (default 0.02)
//   AGENT_FUNDING_THRESHOLD_SOL     — below this balance, registration triggers
//                                     a funding transaction (default 0.01)
//   MAX_TOKENS_PER_MESSAGE          — cumulative token cap per single user message
//                                     across all steps (default 100000)
//   MAX_TOOL_EXECUTIONS_PER_MESSAGE — max tool calls per single user message
//                                     across all steps (default 30)
// ---------------------------------------------------------------------------

const serverLimitsSchema = z.object({
  AGENT_FUNDING_SOL: z.coerce.number().min(0).max(10).default(0.02),
  AGENT_FUNDING_THRESHOLD_SOL: z.coerce.number().min(0).max(10).default(0.01),
  MAX_TOKENS_PER_MESSAGE: z.coerce.number().int().min(1).default(100000),
  MAX_TOOL_EXECUTIONS_PER_MESSAGE: z.coerce.number().int().min(1).default(30),
});

export type ServerLimits = z.infer<typeof serverLimitsSchema>;

let _limits: ServerLimits | null = null;

export function getServerLimits(): ServerLimits {
  if (!_limits) {
    const result = serverLimitsSchema.safeParse(process.env);
    if (!result.success) {
      const errors = result.error.issues.map(
        (i) => `  ${i.path.join('.')}: ${i.message}`,
      );
      throw new Error(
        `Invalid server-limits configuration:\n${errors.join('\n')}`,
      );
    }
    _limits = result.data;
  }
  return _limits;
}
