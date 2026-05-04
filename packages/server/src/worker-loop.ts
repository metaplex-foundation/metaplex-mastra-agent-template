import {
  appendJournal,
  createUmi,
  getAgentPda,
  getConfig,
  getState,
  incrementErrorStreak,
  resetErrorStreak,
  setLastTickAt,
  type AgentContext,
  type TxCounter,
} from '@metaplex-agent/shared';
import { publicKey as toPublicKey } from '@metaplex-foundation/umi';
import { RequestContext } from '@mastra/core/request-context';
import type { createAgent } from '@metaplex-agent/core';
import { buildTickPrompt, type TickContext } from './build-tick-prompt.js';

type Agent = ReturnType<typeof createAgent>;

/**
 * Drives the autonomous-mode worker loop. One instance per process.
 *
 * Lifecycle:
 *   - `start()` kicks off `loop()`, which is `while (running) { runTick(); sleep(N); }`.
 *   - `stop()` flips `running=false` and aborts any in-flight tick (via the
 *     per-tick AbortController) and any pending sleep (via abortable sleep).
 *     Returns when the loop has exited cleanly.
 *
 * Contract:
 *   - At most one tick body runs at a time per instance (the loop is serial).
 *   - The chat path can run concurrently — they share the Mastra agent.
 *     Mastra agents are stateless per call; each `generate()` gets its own
 *     RequestContext, so no cross-call interference.
 */
export class WorkerLoop {
  private running = false;
  private exited: Promise<void> = Promise.resolve();
  private currentSleepAbort: AbortController | null = null;
  private currentTickAbort: AbortController | null = null;

  constructor(
    private readonly agent: Agent,
    private readonly ownerWallet: string,
  ) {}

  /** Start the loop. Idempotent — calling twice is a no-op. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.exited = this.loop();
  }

  /** Stop the loop. Resolves once the in-flight tick (if any) has unwound. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.currentSleepAbort?.abort();
    this.currentTickAbort?.abort();
    await this.exited;
  }

  private async loop(): Promise<void> {
    const config = getConfig();
    while (this.running) {
      try {
        await this.runTick();
      } catch (err) {
        // runTick already handles errors and bumps the error streak; this
        // catch is purely defensive in case an unexpected throw leaks out.
        console.error('[worker-loop] unexpected error in tick:', err);
      }
      if (!this.running) break;
      await this.sleep(config.TICK_INTERVAL_MS);
    }
  }

  private async runTick(): Promise<void> {
    const config = getConfig();
    const state = getState();
    const ts = new Date().toISOString();
    const tickAbort = new AbortController();
    this.currentTickAbort = tickAbort;

    // --- Guardrails: short-circuit before any LLM cost ---
    if (state.paused) {
      console.log('[worker-loop] tick: paused, skipping');
      setLastTickAt(ts);
      return;
    }
    // Idle check looks at *active* goals and *open* tasks only — completed/
    // abandoned items live forever in state for audit, but they shouldn't
    // keep the loop awake doing nothing.
    const hasActiveGoals = state.goals.some((g) => g.status === 'active');
    const hasOpenTasks = state.tasks.some(
      (t) => t.status === 'pending' || t.status === 'in_progress',
    );
    if (!hasActiveGoals && !hasOpenTasks) {
      console.log('[worker-loop] tick: idle (no active goals or open tasks; brief me via chat)');
      setLastTickAt(ts);
      return;
    }

    // --- Gather deterministic context (no LLM yet) ---
    const tickContext = await this.gatherContext({ ts, state, config });

    // --- Build the tick prompt ---
    const prompt = buildTickPrompt(tickContext);

    // --- Build a per-tick TxCounter that submitOrSend will respect ---
    const txCounter: TxCounter = { count: 0, max: config.MAX_TICK_TX_COUNT };

    // --- Construct the RequestContext: same shape as the chat path uses,
    //     plus the per-tick TxCounter. `withAuth` reads `walletAddress` as
    //     the connectedWallet for owner gating (see shared/auth.ts), so we
    //     set it to the resolved ownerWallet — the worker tick stands in
    //     as the owner doing scheduled work. ---
    type ExtendedContext = AgentContext & { abortSignal: AbortSignal };
    const requestContext = new RequestContext<ExtendedContext>([
      ['walletAddress', this.ownerWallet],
      ['transactionSender', null],
      ['agentMode', 'autonomous'],
      ['agentAssetAddress', config.AGENT_ASSET_ADDRESS ?? null],
      ['agentTokenMint', config.AGENT_TOKEN_MINT ?? null],
      ['agentFeeSol', config.AGENT_FEE_SOL],
      ['tokenOverride', config.TOKEN_OVERRIDE ?? null],
      ['ownerWallet', this.ownerWallet],
      ['txCounter', txCounter],
      ['abortSignal', tickAbort.signal],
    ]);

    try {
      const result = await this.agent.generate(
        [{ role: 'user', content: prompt }],
        {
          requestContext: requestContext as any,
          maxSteps: config.MAX_STEPS,
          abortSignal: tickAbort.signal,
        },
      );

      const summary = deriveTickSummary(result);
      appendJournal({
        ts,
        kind: 'tick',
        summary,
        txSigs: collectTxSigs(result),
      });
      resetErrorStreak();
      console.log(`[worker-loop] tick: ${summary}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const streak = incrementErrorStreak();
      appendJournal({
        ts,
        kind: 'error',
        summary: `tick failed (streak=${streak}): ${message}`.slice(0, 500),
        txSigs: [],
      });
      console.error(`[worker-loop] tick failed (streak=${streak}):`, err);
    } finally {
      setLastTickAt(ts);
      this.currentTickAbort = null;
    }
  }

  /** Build the deterministic snapshot the LLM will see this tick. */
  private async gatherContext(args: {
    ts: string;
    state: ReturnType<typeof getState>;
    config: ReturnType<typeof getConfig>;
  }): Promise<TickContext> {
    const { ts, state, config } = args;
    const umi = createUmi();
    const agentKeypairAddress = umi.identity.publicKey.toString();

    // Keypair balance — always queryable.
    let agentKeypairBalanceSol = 0;
    try {
      const balance = await umi.rpc.getBalance(umi.identity.publicKey);
      agentKeypairBalanceSol = Number(balance.basisPoints) / 1_000_000_000;
    } catch (err) {
      console.warn('[worker-loop] failed to fetch agent keypair balance:', err);
    }

    // PDA balance — only if registered. Don't crash the whole tick if RPC
    // hiccups; the model can call tools to retry if it cares.
    let agentPdaAddress: string | null = null;
    let agentPdaBalanceSol: number | null = null;
    if (config.AGENT_ASSET_ADDRESS) {
      try {
        const pda = getAgentPda(umi, toPublicKey(config.AGENT_ASSET_ADDRESS));
        agentPdaAddress = pda.toString();
        const balance = await umi.rpc.getBalance(pda);
        agentPdaBalanceSol = Number(balance.basisPoints) / 1_000_000_000;
      } catch (err) {
        console.warn('[worker-loop] failed to fetch agent PDA balance:', err);
      }
    }

    const recentlyClosedTasks = state.tasks
      .filter((t) => t.status === 'done' || t.status === 'failed')
      .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
      .slice(0, 5);

    return {
      nowIso: ts,
      agentKeypairAddress,
      agentKeypairBalanceSol,
      agentPdaAddress,
      agentPdaBalanceSol,
      goals: state.goals.filter((g) => g.status === 'active'),
      openTasks: state.tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress'),
      recentlyClosedTasks,
      recentJournal: state.journal.slice(-5),
      txCapMax: config.MAX_TICK_TX_COUNT,
      dryRun: config.AUTONOMOUS_DRY_RUN,
    };
  }

  /** Abortable sleep. Resolves on timeout OR on stop()-triggered abort. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const ac = new AbortController();
      this.currentSleepAbort = ac;
      const timer = setTimeout(() => {
        this.currentSleepAbort = null;
        resolve();
      }, ms);
      ac.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        this.currentSleepAbort = null;
        resolve();
      });
    });
  }
}

/**
 * Pull a short, useful summary out of an agent.generate() result. Prefers
 * the model's text output; if the turn was tool-only (no text), synthesizes
 * a summary from the tool call list so the journal isn't empty.
 */
function deriveTickSummary(result: any): string {
  const text = typeof result?.text === 'string' ? result.text.trim() : '';
  if (text.length > 0) {
    return text.slice(0, 500);
  }
  const toolCalls: any[] = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
  if (toolCalls.length === 0) {
    return '(empty turn — no text or tool calls)';
  }
  const names = toolCalls.map((c) => c.toolName ?? c.name ?? 'unknown').join(', ');
  return `tool-only turn: called ${names}`.slice(0, 500);
}

/**
 * Pull any base58 transaction signatures out of an agent.generate() result.
 * We look at tool results that carry a `signature` field. Misses are fine —
 * the journal is a hint, not an audit log.
 */
function collectTxSigs(result: any): string[] {
  const sigs: string[] = [];
  const toolResults: any[] = Array.isArray(result?.toolResults) ? result.toolResults : [];
  for (const r of toolResults) {
    const value = r?.result;
    if (value && typeof value === 'object') {
      const sig = (value as any).signature;
      if (typeof sig === 'string' && sig.length > 0) {
        sigs.push(sig);
      }
    }
  }
  return sigs;
}
