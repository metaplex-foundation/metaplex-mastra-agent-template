import type { Goal, Task, JournalEntry } from '@metaplex-agent/shared';

/**
 * Snapshot of everything the LLM should consider during a tick. Built
 * deterministically by the worker loop (no LLM cost), so the model has
 * a stable, structured view each time.
 */
export interface TickContext {
  /** ISO timestamp of when this tick started. */
  nowIso: string;
  /** Agent keypair pubkey — signs transactions; pays fees. */
  agentKeypairAddress: string;
  /** SOL balance on the agent keypair (always populated). */
  agentKeypairBalanceSol: number;
  /** Asset signer PDA pubkey — only set after register-agent has run. */
  agentPdaAddress: string | null;
  /** SOL balance on the agent PDA (if registered). */
  agentPdaBalanceSol: number | null;
  /** Active goals (filtered to status === 'active'). */
  goals: Goal[];
  /** Open tasks (filtered to status in ['pending', 'in_progress']). */
  openTasks: Task[];
  /**
   * Most recently closed tasks (status in ['done', 'failed']), sorted by
   * completedAt desc. Lets the agent see what it just finished — the
   * `result` field is the only durable record of completed work besides
   * the bounded journal.
   */
  recentlyClosedTasks: Task[];
  /** Most recent journal entries (tail of the ring buffer). */
  recentJournal: JournalEntry[];
  /** Per-tick transaction cap that will apply to this run. */
  txCapMax: number;
  /** Whether AUTONOMOUS_DRY_RUN is on (tx will be simulated, not broadcast). */
  dryRun: boolean;
}

/**
 * Render a structured tick prompt. This is the single dev-customizable
 * surface for "what does the agent see each tick" — fork it to change
 * the layout, add fields (e.g. token prices, balances, account changes),
 * or restrict what the agent considers.
 *
 * Goals are kept terse so the prompt stays well under any practical
 * context window even with many goals/tasks. The model has enough to
 * decide; if it needs more, it has tools.
 */
export function buildTickPrompt(ctx: TickContext): string {
  const lines: string[] = [];

  lines.push('You are an autonomous agent. This is a scheduled tick — there is no human present in the conversation.');
  lines.push('');

  lines.push('## Current state');
  lines.push(`- Time: ${ctx.nowIso}`);
  lines.push(`- Agent keypair: ${ctx.agentKeypairAddress} (${formatSol(ctx.agentKeypairBalanceSol)} SOL)`);
  if (ctx.agentPdaAddress !== null) {
    const pdaSol = ctx.agentPdaBalanceSol === null ? 'unknown' : `${formatSol(ctx.agentPdaBalanceSol)} SOL`;
    lines.push(`- Agent PDA (treasury): ${ctx.agentPdaAddress} (${pdaSol})`);
  } else {
    lines.push('- Agent PDA: not yet registered (call register-agent if you have a goal that requires it).');
  }
  lines.push('');

  if (ctx.goals.length === 0) {
    lines.push('## Active goals');
    lines.push('(none — the owner has not briefed any goals yet. If you have nothing to do, stand down.)');
  } else {
    lines.push(`## Active goals (${ctx.goals.length})`);
    for (const g of ctx.goals) {
      lines.push(`- ${g.id}: ${g.description}`);
    }
  }
  lines.push('');

  if (ctx.openTasks.length === 0) {
    lines.push('## Open tasks');
    lines.push('(none — spawn tasks via add-task when you decide to act.)');
  } else {
    lines.push(`## Open tasks (${ctx.openTasks.length})`);
    for (const t of ctx.openTasks) {
      const link = t.goalId ? ` [goal: ${t.goalId}]` : '';
      lines.push(`- ${t.id} [${t.status}]${link}: ${t.description}`);
    }
  }
  lines.push('');

  if (ctx.recentlyClosedTasks.length > 0) {
    lines.push(`## Recently closed tasks (last ${ctx.recentlyClosedTasks.length})`);
    for (const t of ctx.recentlyClosedTasks) {
      const result = t.result ?? '(no result recorded)';
      lines.push(`- ${t.id} [${t.status}] ${t.description} → ${result}`);
    }
    lines.push('');
  }

  if (ctx.recentJournal.length > 0) {
    lines.push(`## Recent journal (last ${ctx.recentJournal.length})`);
    for (const entry of ctx.recentJournal) {
      const sigs = entry.txSigs.length > 0 ? ` sigs=${entry.txSigs.join(',')}` : '';
      lines.push(`- ${entry.ts} [${entry.kind}] ${entry.summary}${sigs}`);
    }
    lines.push('');
  }

  lines.push('## Limits');
  lines.push(`- Per-tick transaction cap: ${ctx.txCapMax} (resets each tick)`);
  lines.push(`- Dry run: ${ctx.dryRun ? 'ENABLED — transactions are simulated, not broadcast' : 'disabled — transactions will hit the network'}`);
  lines.push('');

  lines.push('## Instructions');
  lines.push('Decide whether to act now. Standing down is a valid choice — say so briefly.');
  lines.push('If you act, prefer working through open tasks before spawning new ones.');
  lines.push('Use add-task to plan; close-task with a useful `result` to record completed work; close-goal if a goal is genuinely achieved or abandoned.');
  lines.push('Keep your response under 200 characters — there is no human reading in real time.');

  return lines.join('\n');
}

function formatSol(value: number): string {
  // Pretty-print SOL with up to 4 decimals, trimming trailing zeros.
  return value.toFixed(4).replace(/\.?0+$/, '') || '0';
}
