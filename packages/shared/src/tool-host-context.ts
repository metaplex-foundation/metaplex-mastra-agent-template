import {
  type AgentContext,
  type StateStore,
  type TransactionSender,
  type TxCounter,
} from '@metaplex-foundation/agent-tools';
import { createUmi } from './umi.js';
import { getConfig, updateConfigFromState } from './config.js';
import { getServerLimits } from './server-limits.js';
import {
  setState,
  addGoal,
  closeGoal,
  getGoalById,
  addTask,
  closeTask,
  setPaused,
  appendJournal,
} from './state.js';
import { clearOwnerCache } from './owner-resolution.js';
import { printRegistrationBanner } from './registration-banner.js';
import { ensureAgentFunded } from './funding.js';

/**
 * Per-request inputs that vary by call site (chat path vs worker tick).
 * Everything else (umi, env-driven knobs, callbacks, state) is built from
 * `getConfig()` and the template's `agent-state.json` IO.
 */
export interface ToolHostContextOpts {
  /** The connected user's wallet (chat path) or the resolved owner (worker loop). */
  walletAddress: string | null;
  /** Resolved on-chain owner (from `resolveOwner(...)`). */
  ownerWallet: string | null;
  /** Sender for user-signed transactions. null in pure autonomous mode. */
  transactionSender: TransactionSender | null;
  /** Per-tick tx cap. null in chat path. */
  txCounter: TxCounter | null;
  /** Caller-supplied abort signal — exposed under 'abortSignal' for the sleep tool. */
  abortSignal?: AbortSignal;
}

/**
 * Build the `RequestContext` entry array for tool calls. Pass the return
 * value to `new RequestContext([...])`.
 *
 * Reads env via `getConfig()`, agent state via `agent-state.json`, and
 * wires up the host-implemented side-effect callbacks (state writes,
 * banner, owner-cache invalidation, public-mode funding).
 *
 * Returns `[key, value][]` rather than a `RequestContext` so callers can
 * append extra keys (e.g. `abortSignal`) before constructing.
 */
export function buildToolHostContext(
  opts: ToolHostContextOpts,
): Array<[keyof AgentContext | 'abortSignal', unknown]> {
  const config = getConfig();
  const limits = getServerLimits();
  const umi = createUmi();

  const network: AgentContext['network'] = config.SOLANA_RPC_URL.includes('devnet')
    ? 'solana-devnet'
    : 'solana-mainnet';

  // State store adapter — closes over the file-backed `agent-state.json`
  // functions from this package. A fork can swap this for Redis/Postgres.
  const stateStore: StateStore = {
    addGoal,
    closeGoal,
    getGoalById,
    addTask,
    closeTask,
    setPaused,
    appendJournal,
  };

  const entries: Array<[keyof AgentContext | 'abortSignal', unknown]> = [
    ['umi', umi],
    ['network', network],
    ['agentMode', config.AGENT_MODE],
    ['agentKeypairAddress', umi.identity.publicKey.toString()],
    ['walletAddress', opts.walletAddress],
    ['ownerWallet', opts.ownerWallet],
    ['agentAssetAddress', config.AGENT_ASSET_ADDRESS ?? null],
    ['agentTokenMint', config.AGENT_TOKEN_MINT ?? null],
    ['tokenOverride', config.TOKEN_OVERRIDE ?? null],
    ['transactionSender', opts.transactionSender],
    ['txCounter', opts.txCounter],
    ['dryRun', config.AUTONOMOUS_DRY_RUN],
    ['maxSlippageBps', config.MAX_SLIPPAGE_BPS],
    ['maxPriceImpactPct', config.MAX_PRICE_IMPACT_PCT],
    ['agentFeeSol', config.AGENT_FEE_SOL],
    ['jupiterApiKey', config.JUPITER_API_KEY ?? null],
    ['state', stateStore],
    [
      'onAssetRegistered',
      (address: string) => {
        setState({ agentAssetAddress: address });
        updateConfigFromState();
        clearOwnerCache();
        printRegistrationBanner({
          kind: 'agent',
          address,
          envKey: 'AGENT_ASSET_ADDRESS',
        });
      },
    ],
    [
      'onTokenLaunched',
      (mint: string) => {
        setState({ agentTokenMint: mint });
        updateConfigFromState();
        printRegistrationBanner({
          kind: 'token',
          address: mint,
          envKey: 'AGENT_TOKEN_MINT',
        });
      },
    ],
    [
      'ensureFunded',
      async () => {
        const partial: AgentContext = {
          umi,
          network,
          agentMode: config.AGENT_MODE,
          agentKeypairAddress: umi.identity.publicKey.toString(),
          walletAddress: opts.walletAddress,
          ownerWallet: opts.ownerWallet,
          agentAssetAddress: config.AGENT_ASSET_ADDRESS ?? null,
          agentTokenMint: config.AGENT_TOKEN_MINT ?? null,
          tokenOverride: config.TOKEN_OVERRIDE ?? null,
          transactionSender: opts.transactionSender,
          txCounter: opts.txCounter,
          dryRun: config.AUTONOMOUS_DRY_RUN,
          maxSlippageBps: config.MAX_SLIPPAGE_BPS,
          maxPriceImpactPct: config.MAX_PRICE_IMPACT_PCT,
          agentFeeSol: config.AGENT_FEE_SOL,
          jupiterApiKey: config.JUPITER_API_KEY ?? null,
          state: stateStore,
          onAssetRegistered: null,
          onTokenLaunched: null,
          ensureFunded: null,
        };
        const result = await ensureAgentFunded(umi, partial);
        if (!result.funded) {
          throw new Error(result.reason);
        }
      },
    ],
  ];
  // limits is referenced via getServerLimits() inside ensureAgentFunded;
  // pulling it here forces the lazy singleton to initialize early so any
  // env error surfaces synchronously at agent-assembly time.
  void limits;

  if (opts.abortSignal) {
    entries.push(['abortSignal', opts.abortSignal]);
  }
  return entries;
}
