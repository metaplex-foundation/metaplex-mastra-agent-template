import { config } from 'dotenv';
import { resolve } from 'path';
import { z } from 'zod';

// Load .env from workspace root
config({ path: resolve(process.cwd(), '.env') });

const envSchema = z.object({
  AGENT_MODE: z.enum(['public', 'autonomous']).default('public'),
  LLM_MODEL: z.string().default('anthropic/claude-sonnet-4-5-20250929'),
  SOLANA_RPC_URL: z.string().default('https://api.devnet.solana.com'),
  AGENT_KEYPAIR: z.string().optional(),
  WEB_CHANNEL_PORT: z.coerce.number().default(3002),
  WEB_CHANNEL_TOKEN: z.string().min(1, 'WEB_CHANNEL_TOKEN is required'),
  ASSISTANT_NAME: z.string().default('Agent'),
});

export type EnvConfig = z.infer<typeof envSchema>;

let _config: EnvConfig | null = null;

export function getConfig(): EnvConfig {
  if (!_config) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      const errors = result.error.issues.map(
        (i) => `  ${i.path.join('.')}: ${i.message}`
      );
      throw new Error(
        `Invalid environment configuration:\n${errors.join('\n')}\n\nSee .env.example for required variables.`
      );
    }
    _config = result.data;
  }
  return _config;
}

export type AgentMode = 'public' | 'autonomous';
