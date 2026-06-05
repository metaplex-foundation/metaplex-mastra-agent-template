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
  transactionBuilder,
} from '@metaplex-foundation/umi';
import {
  delegateExecutionV1,
  findAgentIdentityV1Pda,
  findExecutiveProfileV1Pda,
  registerExecutiveV1,
  safeFetchExecutionDelegateRecordV1FromSeeds,
  safeFetchExecutiveProfileV1FromSeeds,
} from '@metaplex-foundation/mpl-agent-registry';
import { getConfig } from '@metaplex-foundation/shared';

/**
 * Register the configured plumber/Nori instance as an execution delegate on
 * this agent's on-chain asset. After this one-time step, plumber's executive
 * keypair can charge the agent's PDA wallet directly via Execute CPI on
 * every paid call — no more 402 round-trips.
 *
 * Signer routing (this is the part that matters):
 *
 *   - `delegateExecutionV1`'s `authority` field MUST equal the on-chain
 *     owner of the asset. Whoever ran `register-agent` is the owner — in
 *     practice, the connected user wallet. The agent's executive keypair
 *     is just an executive *on* the asset (delegated to itself by the
 *     owner during registration); it cannot grant *new* delegations.
 *   - We use `submitWithUserWallet` — NOT `submitOrSend` — for two
 *     reasons:
 *       (a) it always routes through the connected user wallet
 *           regardless of `AGENT_MODE`, so the asset owner signs even when
 *           the surrounding agent runs in autonomous mode; and
 *       (b) it skips the `AUTONOMOUS_DRY_RUN` short-circuit that
 *           `submitOrSend` honors. Dry-run mode would otherwise return a
 *           `DRYRUN_xxxxx` fake signature without actually submitting,
 *           leaving the on-chain delegation record uncreated.
 *   - Requires a connected user wallet. A truly headless autonomous
 *     deployment (no wallet, agent keypair is the owner because
 *     register-agent ran under the agent keypair) needs a different path
 *     that's deferred to a follow-up.
 *
 * Cost:
 *   - One-time ~5000-lamport tx fee, paid by whoever signs (the asset
 *     owner). Tiny. After delegation, every paid plumber call settles via
 *     the Execute hook with plumber covering tx fees from its keypair.
 *
 * Idempotency:
 *   - We short-circuit when the on-chain
 *     `ExecutionDelegateRecordV1(plumber_profile, agent_asset)` already
 *     exists — calling again is harmless but wastes a fee.
 */
export const delegateToNori: ToolDefinition = defineTool({
  id: 'delegate-to-nori',
  authLevel: 'owner',
  category: 'registration',
  requires: ['umi-rpc', 'agent-keypair', 'agent-identity'],
  description:
    'One-time setup: grant the configured plumber/Nori instance authority to charge this agent\'s wallet directly. ' +
    'After this, every paid call to plumber settles via the Execute hook instead of the x402 fallback. ' +
    'The connected user wallet (the asset owner from `register-agent`) signs the delegation tx — a wallet popup will appear. ' +
    'Requires a connected wallet; works in both public-mode and autonomous-mode chat sessions.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    status: z.string().optional(),
    code: z.string().optional(),
    delegatedTo: z.string().optional(),
    agentAsset: z.string().optional(),
    signature: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async (_input, { requestContext }) => {
    const context = readAgentContext(requestContext);
    const { umi } = context;
    const config = getConfig();
    if (!config.PLUMBER_URL) {
      return err(
        'INVALID_INPUT',
        'PLUMBER_URL is not set — nothing to delegate to. Set PLUMBER_URL in your .env first.',
      );
    }
    if (!config.AGENT_ASSET_ADDRESS) {
      return err(
        'INVALID_INPUT',
        'AGENT_ASSET_ADDRESS is not set — register the agent first (`register-agent` tool).',
      );
    }

    // 1. Discover plumber's executive pubkey from its agent card. No
    // signature required — public read.
    const baseUrl = config.PLUMBER_URL.replace(/\/+$/, '');
    let plumberExec: string;
    try {
      const res = await fetch(`${baseUrl}/.well-known/agent-card.json`);
      if (!res.ok) {
        return err('RPC_FAILURE', `plumber unreachable (HTTP ${res.status})`);
      }
      const card = (await res.json()) as { serviceExecutiveAddress?: string };
      if (!card.serviceExecutiveAddress) {
        return err(
          'RPC_FAILURE',
          'plumber agent-card.json is missing serviceExecutiveAddress (older plumber version?)',
        );
      }
      plumberExec = card.serviceExecutiveAddress;
    } catch (e) {
      return err(
        'RPC_FAILURE',
        `failed to fetch plumber agent card: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // 2. Derive the on-chain accounts the delegation ixes need.
    //
    // We issue TWO delegations in one tx, both signed by the asset owner:
    //
    //   (a) plumber's executive  → so plumber can Execute-CPI charge the
    //       agent's PDA wallet directly on paid calls (the "delegate-pay"
    //       rail).
    //   (b) THIS agent's own keypair → required so the agent can both
    //       authenticate to plumber (plumber's /auth/handshake checks that
    //       the caller is a registered delegate on the claimed asset) AND
    //       sign Execute-CPI txs from its own PDA in the future. Without
    //       this self-delegation, the handshake fails with `not_delegated`
    //       and every paid call falls back to x402 — exactly the symptom
    //       we're solving.
    //
    // Both delegations share one wallet popup; the user signs once.
    const plumberExecPk = umiPubkey(plumberExec);
    const agentAssetPk = umiPubkey(config.AGENT_ASSET_ADDRESS);
    const agentExecPk = umi.identity.publicKey;
    const plumberProfile = findExecutiveProfileV1Pda(umi, {
      authority: plumberExecPk,
    });
    const agentProfile = findExecutiveProfileV1Pda(umi, {
      authority: agentExecPk,
    });
    const agentIdentity = findAgentIdentityV1Pda(umi, { asset: agentAssetPk });

    // 3. Idempotency: check both delegate records + the agent's own
    // executive profile. The plumber executive profile is assumed to exist
    // (plumber registered itself); ours might not yet — `delegateExecutionV1`
    // requires the profile to be initialized first or it fails with custom
    // error 0xe ("Executive Profile must be initialized").
    const [existingPlumber, existingAgent, agentExecutiveProfile] =
      await Promise.all([
        safeFetchExecutionDelegateRecordV1FromSeeds(
          umi,
          { executiveProfile: plumberProfile[0], agentAsset: agentAssetPk },
          { commitment: 'confirmed' },
        ),
        safeFetchExecutionDelegateRecordV1FromSeeds(
          umi,
          { executiveProfile: agentProfile[0], agentAsset: agentAssetPk },
          { commitment: 'confirmed' },
        ),
        safeFetchExecutiveProfileV1FromSeeds(
          umi,
          { authority: agentExecPk },
          { commitment: 'confirmed' },
        ),
      ]);
    if (existingPlumber && existingAgent) {
      return ok({
        delegatedTo: plumberExec,
        agentAsset: config.AGENT_ASSET_ADDRESS,
        message:
          `Already delegated: plumber (${plumberExec}) and self (${agentExecPk.toString()}). Paid calls settle via the Execute hook.`,
      });
    }

    // 4. Bail with a clear error when there's no connected wallet to sign.
    // `submitWithUserWallet` would throw a less specific error in that
    // case; surfacing the precondition here is friendlier.
    if (!context.walletAddress) {
      return err(
        'UNAUTHORIZED',
        'no connected wallet — `delegate-to-nori` needs the asset-owner wallet to sign. ' +
          'Connect the owner wallet via the chat UI and retry.',
      );
    }

    // 5. Build the delegation tx. The registry program requires the asset
    // *owner* to sign as `authority` — that's the connected user wallet
    // (whoever ran `register-agent`), NOT `umi.identity` (which in this
    // template is the agent keypair).
    //
    // We pass both `authority` and `payer` as a noop-signer for the
    // connected wallet pubkey: the noop signer reserves the signature
    // slot in the tx without producing a signature locally; the real
    // signature is filled in when `submitWithUserWallet` hands the tx
    // off to the user's wallet for approval.
    //
    // Both delegation ixes share the same authority signer slot, so the
    // user signs just once and both ixes settle atomically.
    const walletSigner = createNoopSigner(umiPubkey(context.walletAddress));
    let builder = transactionBuilder();
    // 5a. Initialize the agent's executive profile if it doesn't exist yet.
    //
    // CRITICAL: pass `authority` explicitly. Kinobi's account-default logic
    // is "derive executiveProfile from payer when authority is unset" —
    // since we're passing the user wallet as payer, the default would
    // initialize the *user wallet's* profile PDA instead of the agent
    // keypair's. We want the agent keypair's profile, so we pass the
    // agent keypair (umi.identity) as authority explicitly. It signs
    // locally as part of submitWithUserWallet's pre-sign step.
    if (!agentExecutiveProfile) {
      builder = builder.add(
        registerExecutiveV1(umi, {
          authority: umi.identity,
          payer: walletSigner,
        }),
      );
    }
    if (!existingPlumber) {
      builder = builder.add(
        delegateExecutionV1(umi, {
          executiveProfile: plumberProfile,
          agentAsset: agentAssetPk,
          agentIdentity,
          authority: walletSigner,
          payer: walletSigner,
        }),
      );
    }
    if (!existingAgent) {
      builder = builder.add(
        delegateExecutionV1(umi, {
          executiveProfile: agentProfile,
          agentAsset: agentAssetPk,
          agentIdentity,
          authority: walletSigner,
          payer: walletSigner,
        }),
      );
    }

    // 6. Hand off to the connected wallet for signing. Wallet popup
    // appears in the chat UI; the user approves; the wallet submits to
    // its own RPC; signature is returned once confirmed.
    try {
      const signature = await submitWithUserWallet(umi, builder, context, {
        message:
          `Delegate execution to plumber (${plumberExec.slice(0, 8)}\u2026) and to this agent's own executive ` +
          `(${agentExecPk.toString().slice(0, 8)}\u2026). One-time setup; after this, every paid plumber ` +
          `call settles via the Execute hook on this agent's PDA wallet.`,
      });
      return ok({
        delegatedTo: plumberExec,
        agentAsset: config.AGENT_ASSET_ADDRESS,
        signature,
        message:
          `Delegated execution to plumber (${plumberExec}) and to self (${agentExecPk.toString()}). ` +
          `Future paid calls draw from this agent's PDA via the Execute hook — no more x402 round-trips.`,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err('GENERIC', `delegation failed: ${reason}`);
    }
  },
});
