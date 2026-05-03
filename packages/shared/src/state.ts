import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { resolve, dirname } from 'path';
import { randomUUID } from 'crypto';

const STATE_FILENAME = 'agent-state.json';
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/** Cap on the journal ring buffer. Keeps state file small and bounds context cost. */
export const JOURNAL_MAX_ENTRIES = 20;

/** Consecutive failed-tick threshold that triggers an auto-pause. */
export const ERROR_STREAK_AUTO_PAUSE = 3;

/**
 * Anchor the state file to the pnpm workspace root. Walks up from `from`
 * looking for `pnpm-workspace.yaml`; if found, writes `agent-state.json`
 * alongside it. If no workspace root is found (monorepo marker missing),
 * falls back to `<from>/agent-state.json` so behavior stays sane in
 * standalone setups.
 */
function findStateFile(from: string): string {
  let dir = from;
  while (true) {
    if (existsSync(resolve(dir, WORKSPACE_MARKER))) {
      return resolve(dir, STATE_FILENAME);
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  // No workspace root found — default next to cwd.
  return resolve(from, STATE_FILENAME);
}

let _statePath: string | null = null;

function getStatePath(): string {
  if (!_statePath) {
    _statePath = findStateFile(process.cwd());
  }
  return _statePath;
}

// ---------------------------------------------------------------------------
// Autonomous-mode state shapes
// ---------------------------------------------------------------------------

export interface Goal {
  id: string;
  description: string;
  createdAt: string;
  status: 'active' | 'achieved' | 'abandoned';
}

export interface Task {
  id: string;
  goalId: string | null;
  description: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  createdAt: string;
  completedAt: string | null;
  result: string | null;
}

export interface JournalEntry {
  ts: string;
  kind: 'tick' | 'goal_set' | 'pause' | 'unpause' | 'error';
  summary: string;
  txSigs: string[];
}

export interface AgentState {
  // Identity (set by register-agent / launch-token)
  agentAssetAddress?: string;
  agentTokenMint?: string;

  // Autonomous-mode working memory (ignored / unused in public mode)
  goals: Goal[];
  tasks: Task[];
  journal: JournalEntry[];
  paused: boolean;
  errorStreak: number;
  lastTickAt: string | null;
}

/** Default values applied when a field is missing from the on-disk file. */
function defaults(): Pick<AgentState, 'goals' | 'tasks' | 'journal' | 'paused' | 'errorStreak' | 'lastTickAt'> {
  return {
    goals: [],
    tasks: [],
    journal: [],
    paused: false,
    errorStreak: 0,
    lastTickAt: null,
  };
}

export function getState(): AgentState {
  const path = getStatePath();
  let raw: Partial<AgentState> = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AgentState>;
    } catch {
      // Corrupted file — treat as empty. The next setState will overwrite it.
      raw = {};
    }
  }
  const d = defaults();
  return {
    agentAssetAddress: raw.agentAssetAddress,
    agentTokenMint: raw.agentTokenMint,
    goals: raw.goals ?? d.goals,
    tasks: raw.tasks ?? d.tasks,
    journal: raw.journal ?? d.journal,
    paused: raw.paused ?? d.paused,
    errorStreak: raw.errorStreak ?? d.errorStreak,
    lastTickAt: raw.lastTickAt ?? d.lastTickAt,
  };
}

/**
 * Atomically write `merged` to disk. Writes to a sibling tmp file with mode
 * 0600, then renames over the target — a partial write or crash mid-rename
 * never leaves the agent without a state file.
 */
function writeState(merged: AgentState): void {
  const statePath = getStatePath();
  const tmpPath = statePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmpPath, statePath);
}

export function setState(updates: Partial<AgentState>): void {
  const current = getState();
  writeState({ ...current, ...updates });
}

// ---------------------------------------------------------------------------
// ID generation — short prefixed IDs, readable in agent-state.json
// ---------------------------------------------------------------------------

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().split('-')[0]}`;
}

// ---------------------------------------------------------------------------
// Goal helpers
// ---------------------------------------------------------------------------

export function addGoal(description: string): Goal {
  const goal: Goal = {
    id: newId('g'),
    description,
    createdAt: new Date().toISOString(),
    status: 'active',
  };
  const state = getState();
  writeState({ ...state, goals: [...state.goals, goal] });
  return goal;
}

export function closeGoal(id: string, status: 'achieved' | 'abandoned'): Goal | null {
  const state = getState();
  const idx = state.goals.findIndex((g) => g.id === id);
  if (idx === -1) return null;
  const updated: Goal = { ...state.goals[idx]!, status };
  const goals = [...state.goals];
  goals[idx] = updated;
  writeState({ ...state, goals });
  return updated;
}

// ---------------------------------------------------------------------------
// Task helpers
// ---------------------------------------------------------------------------

export function addTask(description: string, goalId: string | null = null): Task {
  const task: Task = {
    id: newId('t'),
    goalId,
    description,
    status: 'pending',
    createdAt: new Date().toISOString(),
    completedAt: null,
    result: null,
  };
  const state = getState();
  writeState({ ...state, tasks: [...state.tasks, task] });
  return task;
}

export function closeTask(id: string, status: 'done' | 'failed', result: string): Task | null {
  const state = getState();
  const idx = state.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const updated: Task = {
    ...state.tasks[idx]!,
    status,
    result,
    completedAt: new Date().toISOString(),
  };
  const tasks = [...state.tasks];
  tasks[idx] = updated;
  writeState({ ...state, tasks });
  return updated;
}

// ---------------------------------------------------------------------------
// Journal helpers (ring buffer, capped to JOURNAL_MAX_ENTRIES)
// ---------------------------------------------------------------------------

export function appendJournal(entry: Omit<JournalEntry, 'ts'> & { ts?: string }): JournalEntry {
  const full: JournalEntry = {
    ts: entry.ts ?? new Date().toISOString(),
    kind: entry.kind,
    summary: entry.summary.length > 500 ? entry.summary.slice(0, 500) : entry.summary,
    txSigs: entry.txSigs ?? [],
  };
  const state = getState();
  const journal = [...state.journal, full];
  if (journal.length > JOURNAL_MAX_ENTRIES) {
    journal.splice(0, journal.length - JOURNAL_MAX_ENTRIES);
  }
  writeState({ ...state, journal });
  return full;
}

// ---------------------------------------------------------------------------
// Pause / error-streak helpers
// ---------------------------------------------------------------------------

export function setPaused(paused: boolean, reason?: string): void {
  const state = getState();
  if (state.paused === paused) return; // idempotent — no journal noise
  writeState({ ...state, paused });
  appendJournal({
    kind: paused ? 'pause' : 'unpause',
    summary: reason ?? (paused ? 'paused' : 'unpaused'),
    txSigs: [],
  });
}

/**
 * Increments the error streak counter. Returns the new value. If it reaches
 * ERROR_STREAK_AUTO_PAUSE, also flips paused=true (with a journal entry
 * tagged 'pause') so the loop stops bleeding RPC credits / LLM cost.
 */
export function incrementErrorStreak(): number {
  const state = getState();
  const errorStreak = state.errorStreak + 1;
  writeState({ ...state, errorStreak });
  if (errorStreak >= ERROR_STREAK_AUTO_PAUSE && !state.paused) {
    setPaused(true, `auto-paused after ${errorStreak} consecutive failed ticks`);
  }
  return errorStreak;
}

export function resetErrorStreak(): void {
  const state = getState();
  if (state.errorStreak === 0) return;
  writeState({ ...state, errorStreak: 0 });
}

export function setLastTickAt(ts: string): void {
  const state = getState();
  writeState({ ...state, lastTickAt: ts });
}
