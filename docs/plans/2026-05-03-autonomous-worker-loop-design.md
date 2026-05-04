# Autonomous Worker Loop — Design

**Status:** approved (pending implementation)
**Date:** 2026-05-03
**Mode affected:** `AGENT_MODE=autonomous` only. Public mode is unchanged.

---

## 1. Background

Today's `AGENT_MODE=autonomous` is reactive: the agent only runs when an authenticated owner sends a chat message over the WebSocket. The "autonomous" label refers to *who signs transactions* (the agent's keypair) — not to *who decides when work happens* (still the owner). For the use cases this template targets (treasury rebalancers, scheduled buybacks, DCA bots, watcher daemons), that's a glorified ChatGPT wrapper, not an autonomous agent.

This design adds a **worker loop** that wakes up on a timer, reads goals/tasks the owner has briefed via chat, and decides whether to act — using the same Mastra agent, same tools, same context plumbing the chat path uses today.

The owner-gated WebSocket server **stays on** in autonomous mode and becomes the **configuration interface**: brief the agent through chat, inspect goals/tasks/journal in the debug panel, pause via chat. No env-var prompt engineering, no redeploys to change strategy.

---

## 2. Architecture overview

```text
                               +--------------------------+
                               |   agent-state.json       |
                               |   - identity (existing)  |
                               |   - goals[]              |
                               |   - tasks[]              |
                               |   - journal[] (ring)     |
                               |   - paused: bool         |
                               |   - errorStreak: int     |
                               +-----------+--------------+
                                           ^
                               read/write  |  read/write
                       +-------------------+-------------------+
                       |                                       |
            +----------+----------+              +-------------+--------------+
            |   PlexChat WS server |              |   Worker loop              |
            |   (owner-gated)      |              |                            |
            |                      |              |   while (running) {        |
            |   Owner chats:       |              |     await runTick()        |
            |   - briefs goals     |              |     await sleep(N)         |
            |   - inspects tasks   |              |   }                        |
            |   - pause/unpause    |              |                            |
            |   - debug panel live |              |   reads goals + tasks      |
            +----------+-----------+              |   calls agent.generate()   |
                       |                          |   tools mutate state       |
                       v                          +-------------+--------------+
                 agent.generate()                               |
                       |                                        v
                       v                              agent.generate()
                  (shared Mastra agent)
                  same tools, same context
```

**Key invariants:**

- Reactive (chat) and proactive (tick) operation share a single Mastra agent, a single tool registry, a single `agent-state.json`.
- Goals and tasks live in **state**, not in a system-prompt config. The owner *briefs* the agent through chat ("your goal is X") — the agent paraphrases for confirmation and then calls `set_goal` to persist.
- The worker loop is **serial** — only one tick body runs at a time per process. The chat path can interleave at the WS message boundary; Mastra serializes per-agent calls.
- Each tick is a **fresh** `agent.generate()` call. Long-term memory lives in goals + completed tasks; short-term memory lives in the journal tail. There is no rolling LLM context across ticks.

---

## 3. State schema

`agent-state.json` extends with five new top-level keys. Identity loading is unchanged.

```typescript
interface AgentState {
  // --- existing (unchanged) ---
  agentAssetAddress: string | null;
  agentTokenMint: string | null;

  // --- new: autonomous-mode-only, ignored in public mode ---
  goals: Goal[];
  tasks: Task[];
  journal: JournalEntry[];   // ring buffer, capped to 20 entries
  paused: boolean;            // emergency stop, owner-toggleable
  errorStreak: number;        // consecutive failed ticks; auto-pauses at 3
  lastTickAt: string | null;  // ISO timestamp
}

interface Goal {
  id: string;              // ulid
  description: string;     // free-text from owner, agent-paraphrased
  createdAt: string;
  status: 'active' | 'achieved' | 'abandoned';
}

interface Task {
  id: string;              // ulid
  goalId: string | null;   // optional link to a goal
  description: string;     // what the agent intends to do
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  createdAt: string;
  completedAt: string | null;
  result: string | null;   // short summary written on completion
}

interface JournalEntry {
  ts: string;              // ISO timestamp
  kind: 'tick' | 'goal_set' | 'pause' | 'unpause' | 'error';
  summary: string;         // ≤ 500 chars, agent-written
  txSigs: string[];        // any transactions this entry produced
}
```

**Migration:** `readState()` adds defaults for the new fields when reading legacy files (no migration script needed; lazy-fill on read). Atomic write semantics from the existing `state.ts` (mode `0600`, temp+rename) carry over unchanged.

**Why goals + tasks (two-level):**
- Goals are owner intent, paraphrased and acknowledged. They're durable contracts.
- Tasks are agent-spawned tactical work items. Free-floating tasks are allowed (one-off owner request without a standing goal).
- Mirrors how a human assistant works; mirrors how the LLM thinks per tick (small operating set: open tasks).

**Why the journal is bounded:** 20 entries (~5 KB) is enough for "what did I do recently." Older context is summarized into completed tasks (`result` field) and goal status. Avoids context-window blowup and unbounded state growth.

---

## 4. Tick lifecycle

```typescript
async function runTick(): Promise<void> {
  const state = await readState();
  const ts = new Date().toISOString();

  // --- Guardrails (before any LLM cost) ---
  if (state.paused) {
    log('tick: paused, skipping');
    return;
  }
  if (state.goals.length === 0 && state.tasks.length === 0) {
    log('tick: idle (no goals; brief me via chat)');
    return;
  }

  // --- Gather deterministic context (no LLM) ---
  const context = {
    nowIso: ts,
    walletAddress: getAgentWalletAddress(),
    treasuryBalanceSol: await getSolBalance(),
    tokenBalances: await getKnownTokenBalances(),
    goals: state.goals.filter(g => g.status === 'active'),
    openTasks: state.tasks.filter(t => t.status === 'pending' || t.status === 'in_progress'),
    recentJournal: state.journal.slice(-5),
    txCapRemaining: config.MAX_TICK_TX_COUNT,
    dryRun: config.AUTONOMOUS_DRY_RUN,
  };

  // --- Hand off to the LLM ---
  const prompt = buildTickPrompt(context);
  try {
    const result = await agent.generate({
      messages: [{ role: 'user', content: prompt }],
      requestContext: new RequestContext([
        ['agentContext', { mode: 'autonomous-tick', txCapRemaining: context.txCapRemaining }],
      ]),
    });
    await appendJournal({
      ts,
      kind: 'tick',
      summary: result.text.slice(0, 500),
      txSigs: collectTxSigs(result),
    });
    await resetErrorStreak();
  } catch (err) {
    await incrementErrorStreak(); // auto-pauses at 3
    await appendJournal({ ts, kind: 'error', summary: errorMessage(err), txSigs: [] });
    log('tick: failed', err);
  } finally {
    await setLastTickAt(ts);
  }
}
```

`buildTickPrompt(context)` is the **single dev-customizable surface** for "what does the agent see each tick." Default implementation produces a structured prompt:

> *You are an autonomous agent. Current time: 2026-05-03T14:00:00Z. Your wallet: `Xy7…aB2`. Treasury: 12.4 SOL. Active goals: 1) DCA into MPLX (~$50/week). Open tasks: 1) Buy ~0.3 SOL of MPLX before EOD. Recent journal: [yesterday: bought 0.28 SOL of MPLX]. Transaction cap remaining: 3. Dry run: false. Decide whether to act now. If you act, call tools; if not, briefly explain why you're standing down. Keep your response under 200 chars.*

**Tx cap enforcement:** `MAX_TICK_TX_COUNT` flows into `requestContext` as `txCapRemaining`. The transaction-submitting tools read it, decrement on success, and refuse on 0. Reset is implicit — each tick gets a fresh budget. (A daily/global cap is explicitly not in v1; the agent itself can self-impose one as a goal.)

**Concurrency:** the loop is `await runTick(); await sleep(N)`, so only one tick is in flight per process. The chat path interleaves at WS message boundaries; if Mastra doesn't serialize per-agent `generate()` calls, we add a per-process mutex (~5 LOC). To verify in implementation.

---

## 5. Tools the agent gains

Five new state-mutating tools, registered under `autonomousToolNames` (not `publicToolNames`) so public-mode forks never see them.

```typescript
set_goal({ description: string }): { goalId: string }
close_goal({ goalId: string, status: 'achieved' | 'abandoned', reason?: string }): { ok: true }
add_task({ description: string, goalId?: string }): { taskId: string }
close_task({ taskId: string, status: 'done' | 'failed', result: string }): { ok: true }
set_paused({ paused: boolean, reason?: string }): { ok: true }
```

**Symmetric verbs (set/close).** No `update_goal` (just `close_goal` + `set_goal`). No `start_task` (status transitions through `close_task` only). YAGNI.

**System-prompt addendum for autonomous mode:**
> "Before calling `set_goal`, paraphrase the goal back to the owner and ask them to confirm. Goals are durable contracts — getting them right matters more than getting them fast. When you `close_task`, write a result that future-you would find useful one tick from now (what did you actually do, and any number that matters)."

**Chat-path context injection:** `shared/context.ts` (the existing `AgentContext` extractor) gains autonomous-mode fields — `goals`, `tasks`, `journal.tail(5)`, `paused`. The agent answers "what are you working on?" without a fetch tool; the data is in context the same way wallet address already is.

**Tools the agent does NOT get:** there's no `read_state` / `list_goals` / `list_tasks`. State is always *injected* into context (chat) or into the tick prompt (tick). The LLM doesn't need to fetch its own working memory.

---

## 6. Configuration, safety, and boot

**New env vars (autonomous-mode only):**

| Var | Default | Purpose |
|---|---|---|
| `TICK_INTERVAL_MS` | `300000` (5 min) | Sleep between ticks. Tick body runs to completion before sleeping. |
| `AUTONOMOUS_DRY_RUN` | `true` | When `true`, transaction-submitting tools log "would have sent X" and return a fake signature. **Default-on so a fresh fork can't accidentally spend.** Flip to `false` for production. |
| `MAX_TICK_TX_COUNT` | `3` | Per-tick transaction cap. |

`AGENT_MODE=autonomous` (existing) gates whether the worker loop boots at all.

**Boot order in `packages/server/src/index.ts`:**

1. Load + validate config (existing).
2. Read `agent-state.json` (existing) — auto-fills new fields if missing.
3. Start `PlexChatServer` (existing) — WebSocket binds to port.
4. If `AGENT_MODE === 'autonomous'`: `new WorkerLoop(agent, stateStore).start()` — async, non-blocking.
5. SIGINT/SIGTERM handlers shut down both: WS sessions close, worker loop exits its sleep, all in-flight `agent.generate()` aborts.

`WorkerLoop.stop()` sets a flag; the running tick (if any) finishes; the sleep is cancelled via an `AbortController`; the loop exits.

**Pause semantics.** `paused: true` short-circuits the tick body before any LLM cost. Owner sets it via chat → `set_paused({ paused: true })` → tool writes state → next tick reads it and idles. Live owner is unaffected: chat keeps working, the agent can still answer questions, just won't act on its own.

**Error-streak auto-pause.** `errorStreak` increments on `runTick()` catch, resets on success. At 3 it writes `paused=true, reason='error_streak'` and stops the bleeding. Owner sees it on next chat: "I auto-paused after 3 errors. Last error: …". Manual unpause after fixing.

**Dry-run wrap point.** A single helper in `shared/transaction.ts` — `submitOrSimulate()` — checks `AUTONOMOUS_DRY_RUN` and returns a fake-signature stub when true. Existing `submitOrSend()` continues to handle the chat path unchanged.

---

## 7. Files affected

**New:**

```text
packages/server/src/worker-loop.ts        # WorkerLoop class
packages/server/src/build-tick-prompt.ts  # buildTickPrompt(context)
packages/core/src/tools/autonomous/
  goals-tasks.ts                          # set_goal, close_goal, add_task, close_task
  set-paused.ts                           # set_paused
  index.ts                                # barrel + autonomousToolNames addition
```

**Modified:**

```text
packages/shared/src/types/agent.ts        # extended AgentState type
packages/shared/src/state.ts              # default-fill new fields on read
packages/shared/src/context.ts            # inject goals/tasks/journal/paused into AgentContext
packages/shared/src/transaction.ts        # add submitOrSimulate() helper
packages/shared/src/config.ts             # add new env vars
packages/server/src/index.ts              # boot WorkerLoop in autonomous mode
packages/core/src/prompts.ts              # autonomous-mode addendum
packages/core/src/tools/index.ts          # register new tools
.env.example                              # document new env vars
docs/SPEC.md, README.md, docs/DEPLOYMENT.md
```

**UI side (sibling chat-template repo):** two new debug-panel tabs (**Goals**, **Tasks**) reading from the `DebugContext` payload. The protocol type gets `goals`, `tasks`, `paused` fields; the inlined `plexchat-protocol.ts` updates accordingly.

---

## 8. Testing strategy

- **Unit:** state migrators (legacy file → new shape), `buildTickPrompt`, `submitOrSimulate`, error-streak transitions, journal ring-buffer eviction. Pure-function code.
- **Integration:** boot the server with a fixture state file, `AGENT_MODE=autonomous`, `AUTONOMOUS_DRY_RUN=true`, `TICK_INTERVAL_MS=100`. Mock the LLM provider to return canned tool calls. Assert: state transitions, journal grows, dry-run signatures land, pause short-circuits, error streak auto-pauses at 3.
- **Manual smoke:** local devnet, real LLM. Walk the "DCA into MPLX" flow end-to-end via the chat UI. Observe goals/tasks tabs update, journal grow, pause-via-chat work.

---

## 9. Non-goals (v1)

Explicit out-of-scope — flagged so the implementation doesn't sprawl:

- ❌ **Cron-style scheduling.** Sleep-loop only. Devs who need wall-clock cron swap one line.
- ❌ **Multiple concurrent tick handlers.** Single tick fn. Multi-handler registration is a v2 concern.
- ❌ **Persistent rolling LLM context across ticks.** Each tick is a fresh `agent.generate()` call. Memory lives in state, not in the model's context window.
- ❌ **`INITIAL_GOAL` env var.** Briefing happens through chat, period. Forks that want a default goal can add one themselves.
- ❌ **Daily / global tx caps.** Per-tick cap only. The agent itself can track a daily budget as a goal.
- ❌ **Auto-restart of the worker after `paused=true` clears.** Owner unpauses; next sleep tick picks it up naturally — no restart needed.
- ❌ **Event-driven triggers (price feeds, account subscribes).** v2. The sleep-loop trigger is swappable in `WorkerLoop` if a fork needs it.

---

## 10. Open questions / decisions to verify in implementation

1. **Mastra `agent.generate()` serialization.** If two `generate()` calls overlap (chat message arrives mid-tick), does Mastra serialize them? If not, we add a per-process `await mutex.acquire()` in both call sites. Verify in integration test.
2. **Tx cap signal path.** The cleanest way to thread `txCapRemaining` is `requestContext`, but that requires the tools to mutate the context object — currently a read-only-feeling abstraction. May need a small mutable wrapper, or a per-tick callback.
3. **Journal `summary` derivation.** Using `result.text.slice(0, 500)` is crude. The agent often writes "I bought X for Y" inline; that's fine. But if the agent's response is a tool-only turn (no text), the summary will be empty. Fallback: synthesize from the tool calls.
4. **State-mutating tools in chat mode.** `set_paused` is symmetric (owner-callable in chat, agent-callable in emergency). `set_goal` is owner-mediated only — the system prompt instructs paraphrase-then-confirm. If devs want to lock this further, a future addition is a `tool-allowlist` per call mode (chat vs tick).
