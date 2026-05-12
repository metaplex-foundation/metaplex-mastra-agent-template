/**
 * A persona is a swappable "domain identity" for the agent. The shared
 * registration / identity preamble and the mode-specific transaction
 * addendum stay constant; only the persona body changes — the section
 * that defines what the agent specializes in and how it should act.
 *
 * Forks ship the bundled presets and add their own files in this dir as
 * needed. The default persona preserves the original generic prompt so
 * the template behaves the same out of the box.
 */
export interface Persona {
  /** Slug used for AGENT_PERSONA env var lookups. Lowercase, kebab-case. */
  name: string;
  /** Short description shown in `pnpm bootstrap` and developer-facing tooling. */
  description: string;
  /**
   * Domain-specific section of the system prompt. Inserted between the
   * shared registration/identity preamble and the mode-specific addendum.
   * Authors should NOT repeat the bootstrap or transaction-mode content —
   * the prompt builder appends those automatically.
   */
  body: string;
}
