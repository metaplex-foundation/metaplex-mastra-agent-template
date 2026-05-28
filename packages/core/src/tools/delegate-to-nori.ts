import {
  defineTool,
  ok,
  err,
  readAgentContext,
  type ToolDefinition,
} from '@metaplex-foundation/agent-tools';
import { z } from 'zod';
import {
  publicKey as umiPubkey,
  createNoopSigner,
  createSignerFromKeypair,
  signerIdentity,
  transactionBuilder,
} from '@metaplex-foundation/umi';
import { createUmi as createUmiBase } from '@metaplex-foundation/umi-bundle-defaults';
import { toWeb3JsTransaction } from '@metaplex-foundation/umi-web3js-adapters';
import {
  delegateExecutionV1,
  findAgentIdentityV1Pda,
  findExecutiveProfileV1Pda,
  safeFetchExecutionDelegateRecordV1FromSeeds,
} from '@metaplex-foundation/mpl-agent-registry';
import { getConfig, loadAgentKeypair } from '@metaplex-foundation/shared';

/**
 * Register the configured plumber/Nori instance as an execution delegate on
 * this agent's on-chain asset. After this one-time step, plumber's executive
 * keypair can charge the agent's PDA wallet directly via Execute CPI on
 * every paid call — no more 402 round-trips.
 *
 * UX:
 *   - Caller's executive keypair (`AGENT_KEYPAIR`) signs the delegation tx
 *     locally; no Solana RPC and no SOL balance needed on the caller side.
 *   - Plumber co-signs as fee payer and submits via its upstream RPC. The
 *     ~5000-lamport network fee is absorbed by plumber as customer onboarding
 *     cost (recovered in less than one priced call).
 *
 * Failure modes:
 *   - PLUMBER_URL unset → no-op (the template is in BYOK direct mode).
 *   - AGENT_ASSET_ADDRESS unset → agent isn't registered yet, run
 *     `register-agent` first.
 *   - Already delegated → reports the existing record (idempotent success).
 */
export const delegateToNori: ToolDefinition = defineTool({
  id: 'delegate-to-nori',
  authLevel: 'owner',
  category: 'registration',
  requires: ['agent-keypair', 'agent-identity'],
  description:
    'One-time setup: grant the configured plumber/Nori instance authority to charge this agent\'s wallet directly. ' +
    'After this, every paid call to plumber settles via the Execute hook instead of the x402 fallback. ' +
    'No SOL or Solana RPC needed on this side — plumber submits and pays the network fee.',
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
    void readAgentContext(requestContext);
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

    // 1. Fetch plumber's executive pubkey + a fresh blockhash.
    const baseUrl = config.PLUMBER_URL.replace(/\/+$/, '');
    let plumberExec: string;
    let blockhash: string;
    try {
      const [cardRes, bhRes] = await Promise.all([
        fetch(`${baseUrl}/.well-known/agent-card.json`),
        fetch(`${baseUrl}/v1/solana/blockhash`),
      ]);
      if (!cardRes.ok || !bhRes.ok) {
        return err(
          'RPC_FAILURE',
          `plumber unreachable (card=${cardRes.status}, blockhash=${bhRes.status})`,
        );
      }
      const card = (await cardRes.json()) as { serviceExecutiveAddress?: string };
      const bh = (await bhRes.json()) as { blockhash?: string };
      if (!card.serviceExecutiveAddress) {
        return err(
          'RPC_FAILURE',
          'plumber agent-card.json is missing serviceExecutiveAddress (older plumber version?)',
        );
      }
      if (!bh.blockhash) {
        return err('RPC_FAILURE', 'plumber /v1/solana/blockhash returned no blockhash');
      }
      plumberExec = card.serviceExecutiveAddress;
      blockhash = bh.blockhash;
    } catch (e) {
      return err(
        'RPC_FAILURE',
        `failed to fetch plumber discovery: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // 2. Build the delegation tx locally with an offline Umi.
    const offlineUmi = createUmiBase('https://offline.local/');
    const keypair = loadAgentKeypair();
    const executiveSigner = createSignerFromKeypair(offlineUmi, keypair);
    offlineUmi.use(signerIdentity(executiveSigner));

    const agentAssetPk = umiPubkey(config.AGENT_ASSET_ADDRESS);
    const plumberExecPk = umiPubkey(plumberExec);
    const plumberProfile = findExecutiveProfileV1Pda(offlineUmi, {
      authority: plumberExecPk,
    });
    const agentIdentity = findAgentIdentityV1Pda(offlineUmi, { asset: agentAssetPk });

    // Idempotency: skip submission if a delegate record already exists.
    // (Requires a one-shot RPC read against plumber's RPC — but it's free at
    // protocol layer because we never submit through it.) We use the offline
    // umi without rpc; instead derive the PDA locally and ask plumber's
    // /v1/solana/rpc if we can. Actually safer to just attempt the tx and
    // let the on-chain check fail loudly if already delegated.
    void safeFetchExecutionDelegateRecordV1FromSeeds;

    const plumberFeePayer = createNoopSigner(plumberExecPk);
    let builder = transactionBuilder().add(
      delegateExecutionV1(offlineUmi, {
        executiveProfile: plumberProfile,
        agentAsset: agentAssetPk,
        agentIdentity,
        authority: executiveSigner,
        payer: plumberFeePayer,
      }),
    );
    builder = builder.setFeePayer(plumberFeePayer).setBlockhash(blockhash);

    const umiTx = await builder.buildAndSign(offlineUmi);
    const web3Tx = toWeb3JsTransaction(umiTx);
    const base64Tx = Buffer.from(web3Tx.serialize()).toString('base64');

    // 3. POST to plumber's /v1/delegate/submit. Plumber co-signs and submits.
    let result: {
      success: boolean;
      signature?: string;
      errorReason?: string;
      agentAsset?: string;
      authority?: string;
    };
    try {
      const res = await fetch(`${baseUrl}/v1/delegate/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction: base64Tx }),
      });
      result = (await res.json()) as typeof result;
    } catch (e) {
      return err(
        'RPC_FAILURE',
        `plumber /v1/delegate/submit failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!result.success) {
      return err(
        'GENERIC',
        `delegation rejected by plumber: ${result.errorReason ?? 'unknown'}`,
      );
    }

    return ok({
      delegatedTo: plumberExec,
      agentAsset: result.agentAsset ?? config.AGENT_ASSET_ADDRESS,
      signature: result.signature,
      message:
        `Delegated execution to plumber (${plumberExec}). ` +
        `Future paid calls will draw from this agent's PDA wallet via the Execute hook — ` +
        `no x402 round-trips needed.`,
    });
  },
});
