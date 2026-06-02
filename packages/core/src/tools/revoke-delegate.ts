import {
  defineTool,
  ok,
  err,
  readAgentContext,
  submitWithUserWallet,
  type ToolDefinition,
} from '@metaplex-foundation/agent-tools';
import { z } from 'zod';
import {
  createNoopSigner,
  publicKey as umiPubkey,
} from '@metaplex-foundation/umi';
import {
  findExecutionDelegateRecordV1Pda,
  findExecutiveProfileV1Pda,
  revokeExecutionV1,
  safeFetchExecutionDelegateRecordV1FromSeeds,
} from '@metaplex-foundation/mpl-agent-registry';
import { getConfig } from '@metaplex-foundation/shared';

/**
 * Revoke a registered execution delegate on this agent's asset.
 *
 * Accepts EITHER:
 *   - `target: "nori" | "plumber"` — resolves to the executive published
 *     by the configured PLUMBER_URL's agent card. Convenient when the
 *     operator just wants to cut Nori off without copy-pasting addresses.
 *   - `delegateAuthority: <base58>` — explicit delegate keypair pubkey.
 *     Use this to revoke arbitrary third-party executives surfaced by
 *     `list-delegates`.
 *
 * Authority semantics: the registry's `revokeExecutionV1` accepts the
 * asset owner OR the delegate themselves as authority. We always route
 * through the connected user wallet (asset owner) because the wallet
 * popup is the cleanest UX seam — and ownership-revoke is the common
 * case ("I want to stop paying via X").
 *
 * Rent on the closed `ExecutionDelegateRecordV1` PDA is refunded to the
 * signer (asset owner) by default. Tiny, but it's their lamports.
 *
 * Idempotency: if the delegate record doesn't exist (already revoked or
 * never set up) we return ok with a message — no wallet popup, no tx.
 */
export const revokeDelegate: ToolDefinition = defineTool({
  id: 'revoke-delegate',
  authLevel: 'owner',
  category: 'registration',
  requires: ['umi-rpc', 'agent-keypair', 'agent-identity'],
  description:
    'Revoke an execution delegate on this agent\'s asset. Pass `target:"nori"` to revoke the configured ' +
    'plumber/Nori instance, or pass `delegateAuthority:<base58>` to revoke an arbitrary executive (use ' +
    '`list-delegates` first to see who\'s registered). The connected user wallet (asset owner) signs the ' +
    'revoke tx — a wallet popup will appear. After revoking Nori, paid plumber calls drop back to x402 ' +
    'instead of settling via the Execute hook.',
  inputSchema: z
    .object({
      target: z.enum(['nori', 'plumber']).optional().describe(
        'Convenience selector for the configured PLUMBER_URL\'s executive. Mutually exclusive with delegateAuthority.',
      ),
      delegateAuthority: z
        .string()
        .optional()
        .describe(
          'Explicit base58 pubkey of the delegate to revoke. Mutually exclusive with target.',
        ),
    })
    .refine(
      (v) => (v.target ? 1 : 0) + (v.delegateAuthority ? 1 : 0) === 1,
      {
        message:
          'Pass exactly one of `target` or `delegateAuthority` — not both, not neither.',
      },
    ),
  outputSchema: z.object({
    status: z.string().optional(),
    code: z.string().optional(),
    revokedAuthority: z.string().optional(),
    agentAsset: z.string().optional(),
    signature: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async (input, { requestContext }) => {
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

    // 1. Resolve the delegate authority pubkey.
    let delegateAuthorityStr: string;
    if (input.target) {
      if (!config.PLUMBER_URL) {
        return err(
          'INVALID_INPUT',
          'PLUMBER_URL is not set — cannot resolve target=' + input.target + '. ' +
            'Set PLUMBER_URL in your .env, or pass `delegateAuthority` explicitly.',
        );
      }
      const baseUrl = config.PLUMBER_URL.replace(/\/+$/, '');
      try {
        const res = await fetch(`${baseUrl}/.well-known/agent-card.json`);
        if (!res.ok) {
          return err('RPC_FAILURE', `plumber unreachable (HTTP ${res.status})`);
        }
        const card = (await res.json()) as { serviceExecutiveAddress?: string };
        if (!card.serviceExecutiveAddress) {
          return err(
            'RPC_FAILURE',
            'plumber agent-card.json is missing serviceExecutiveAddress',
          );
        }
        delegateAuthorityStr = card.serviceExecutiveAddress;
      } catch (e) {
        return err(
          'RPC_FAILURE',
          `failed to fetch plumber agent card: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } else {
      delegateAuthorityStr = input.delegateAuthority!;
    }

    let delegateAuthorityPk;
    try {
      delegateAuthorityPk = umiPubkey(delegateAuthorityStr);
    } catch {
      return err(
        'INVALID_INPUT',
        `delegateAuthority is not a valid base58 pubkey: ${delegateAuthorityStr}`,
      );
    }

    // 2. Derive the executive profile + delegate record PDAs.
    const executiveProfile = findExecutiveProfileV1Pda(umi, {
      authority: delegateAuthorityPk,
    });
    const executionDelegateRecord = findExecutionDelegateRecordV1Pda(umi, {
      executiveProfile: executiveProfile[0],
      agentAsset: agentAssetPk,
    });

    // 3. Idempotency: bail early if the record doesn't exist.
    const existing = await safeFetchExecutionDelegateRecordV1FromSeeds(
      umi,
      { executiveProfile: executiveProfile[0], agentAsset: agentAssetPk },
      { commitment: 'confirmed' },
    );
    if (!existing) {
      return ok({
        revokedAuthority: delegateAuthorityStr,
        agentAsset: config.AGENT_ASSET_ADDRESS,
        message:
          `No active delegation found for ${delegateAuthorityStr} on ${config.AGENT_ASSET_ADDRESS}. ` +
          'Either never delegated or already revoked.',
      });
    }

    // 4. Need the connected wallet (asset owner) to sign as authority.
    if (!context.walletAddress) {
      return err(
        'UNAUTHORIZED',
        'no connected wallet — `revoke-delegate` needs the asset-owner wallet to sign. ' +
          'Connect the owner wallet via the chat UI and retry.',
      );
    }

    // 5. Build the revoke ix. authority + destination + payer all default
    // to the connected wallet — the owner signs, pays a tiny rent-refund
    // recipient that's themselves (net-zero modulo the tx fee).
    const walletSigner = createNoopSigner(umiPubkey(context.walletAddress));
    const builder = revokeExecutionV1(umi, {
      executionDelegateRecord,
      agentAsset: agentAssetPk,
      destination: umiPubkey(context.walletAddress),
      authority: walletSigner,
      payer: walletSigner,
    });

    try {
      const signature = await submitWithUserWallet(umi, builder, context, {
        message:
          `Revoke execution delegate ${delegateAuthorityStr.slice(0, 8)}\u2026 on this agent's asset. ` +
          'After this, that executive can no longer charge the agent PDA via Execute CPI.',
      });
      const isPlumber = input.target === 'nori' || input.target === 'plumber';
      return ok({
        revokedAuthority: delegateAuthorityStr,
        agentAsset: config.AGENT_ASSET_ADDRESS,
        signature,
        message:
          `Revoked delegate ${delegateAuthorityStr} on ${config.AGENT_ASSET_ADDRESS}.` +
          (isPlumber
            ? ' Paid plumber calls will now fall back to x402 — the agent\'s wallet pays each call directly.'
            : ''),
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err('GENERIC', `revoke failed: ${reason}`);
    }
  },
});
