import {
  defineTool,
  ok,
  err,
  readAgentContext,
  type ToolDefinition,
} from '@metaplex-foundation/agent-tools';
import { z } from 'zod';
import { publicKey as umiPubkey } from '@metaplex-foundation/umi';
import { getExecutionDelegateRecordV1GpaBuilder } from '@metaplex-foundation/mpl-agent-registry';
import { getConfig } from '@metaplex-foundation/shared';

/**
 * Enumerate every executive currently registered as an execution delegate
 * on this agent's mpl-core asset.
 *
 * Reads the on-chain state via a GPA query filtered by `agentAsset`. Each
 * `ExecutionDelegateRecordV1` PDA is seeded by `(executiveProfile, asset)`
 * and stores the `authority` pubkey (the delegate's executive keypair) —
 * which is what an operator actually cares about ("who am I paying via?").
 *
 * For each row we also fetch plumber's `serviceExecutiveAddress` from its
 * agent card and the agent's own `umi.identity.publicKey`, so the response
 * can tag each entry with a human-readable role:
 *
 *   - `plumber` — the configured Nori/plumber service.
 *   - `self`    — this agent's own executive keypair (lets paid plumber
 *                 calls authenticate via /auth/handshake).
 *   - `other`   — some third-party executive the owner authorized.
 *
 * Read-only; no on-chain writes, no wallet signature.
 */
export const listDelegates: ToolDefinition = defineTool({
  id: 'list-delegates',
  authLevel: 'public',
  category: 'registration',
  requires: ['umi-rpc', 'agent-identity'],
  description:
    'List every executive currently authorized as an execution delegate on this agent\'s asset. ' +
    'Annotates each entry with its role (plumber, self, or other) and indicates which one is the ' +
    'configured plumber/Nori instance. Read-only — no wallet popup, no on-chain writes.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    status: z.string().optional(),
    code: z.string().optional(),
    agentAsset: z.string().optional(),
    plumberExecutive: z.string().nullable().optional(),
    delegates: z
      .array(
        z.object({
          authority: z.string(),
          executiveProfile: z.string(),
          executionDelegateRecord: z.string(),
          role: z.enum(['plumber', 'self', 'other']),
        }),
      )
      .optional(),
    message: z.string().optional(),
  }),
  execute: async (_input, { requestContext }) => {
    const context = readAgentContext(requestContext);
    const { umi } = context;
    const config = getConfig();

    if (!config.AGENT_ASSET_ADDRESS) {
      return err(
        'INVALID_INPUT',
        'AGENT_ASSET_ADDRESS is not set — register the agent first (`register-agent` tool).',
      );
    }
    const agentAssetPk = umiPubkey(config.AGENT_ASSET_ADDRESS);
    const selfPk = umi.identity.publicKey.toString();

    // Discover plumber's executive — best-effort; missing PLUMBER_URL or
    // unreachable card just leaves `plumberExecutive: null` and the
    // role-tagging falls back to `other` for everything.
    let plumberExec: string | null = null;
    if (config.PLUMBER_URL) {
      try {
        const baseUrl = config.PLUMBER_URL.replace(/\/+$/, '');
        const res = await fetch(`${baseUrl}/.well-known/agent-card.json`);
        if (res.ok) {
          const card = (await res.json()) as { serviceExecutiveAddress?: string };
          plumberExec = card.serviceExecutiveAddress ?? null;
        }
      } catch {
        /* network error → leave plumberExec null */
      }
    }

    let records;
    try {
      records = await getExecutionDelegateRecordV1GpaBuilder(umi)
        .whereField('agentAsset', agentAssetPk)
        .getDeserialized();
    } catch (e) {
      return err(
        'RPC_FAILURE',
        `failed to fetch delegate records: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const delegates = records.map((r) => {
      const authority = r.authority.toString();
      const role: 'plumber' | 'self' | 'other' =
        plumberExec && authority === plumberExec
          ? 'plumber'
          : authority === selfPk
            ? 'self'
            : 'other';
      return {
        authority,
        executiveProfile: r.executiveProfile.toString(),
        executionDelegateRecord: r.publicKey.toString(),
        role,
      };
    });

    const summary = delegates.length === 0
      ? `No execution delegates registered on ${config.AGENT_ASSET_ADDRESS}.`
      : `${delegates.length} delegate(s) registered on ${config.AGENT_ASSET_ADDRESS}: ` +
        delegates.map((d) => `${d.authority} (${d.role})`).join(', ');

    return ok({
      agentAsset: config.AGENT_ASSET_ADDRESS,
      plumberExecutive: plumberExec,
      delegates,
      message: summary,
    });
  },
});
