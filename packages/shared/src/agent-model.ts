import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import { getConfig } from './config.js';
import { createUmi } from './umi.js';
import { getPlumberClient, plumberFetch } from './plumber-client.js';

/**
 * Pick the right `model` value to hand to Mastra's `Agent`:
 *
 *   - In **plumber mode** (PLUMBER_URL set): return an OpenAI-compatible
 *     LanguageModelV2 instance pointing at plumber's `/v1` surface. Auth
 *     bearer + x402 payment retry are handled inside `plumberFetch`, so
 *     this layer is just AI SDK's standard openai-compatible client with
 *     a custom `fetch`.
 *   - In **direct mode** (PLUMBER_URL unset): return the raw `LLM_MODEL`
 *     string. Mastra's router resolves it to the appropriate AI SDK
 *     provider (which reads `ANTHROPIC_API_KEY` etc.).
 *
 * Calling `createUmi()` here ensures the singleton PlumberClient is
 * initialized as a side effect — it's the only entry point that does
 * the lazy wire-up of bearer/handshake state.
 */
export function resolveAgentModel(): LanguageModelV2 | string {
  const config = getConfig();
  if (!config.PLUMBER_URL) {
    return config.LLM_MODEL;
  }
  // Touch Umi to lazily wire the PlumberClient singleton.
  void createUmi();
  const client = getPlumberClient();
  if (!client) {
    throw new Error(
      'PLUMBER_URL is set but PlumberClient is not initialized. ' +
      'This usually means AGENT_ASSET_ADDRESS is unset — register the agent first.',
    );
  }
  // `apiKey: 'plumber'` is a placeholder — plumberFetch overwrites the
  // Authorization header with our bearer before each request, so the
  // openai-compatible provider's apiKey value never reaches plumber.
  // It still has to be present (non-empty) to satisfy the provider's
  // own request-building code path that adds the header.
  const provider = createOpenAICompatible({
    name: 'plumber',
    baseURL: `${client.baseUrl}/v1`,
    apiKey: 'plumber',
    fetch: plumberFetch(client),
  });
  return provider.chatModel(config.LLM_MODEL);
}
