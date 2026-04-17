import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { resolve, dirname } from 'path';

const STATE_FILENAME = 'agent-state.json';
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

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

export interface AgentState {
  agentAssetAddress?: string;
  agentTokenMint?: string;
}

export function getState(): AgentState {
  const path = getStatePath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as AgentState;
  } catch {
    return {};
  }
}

export function setState(updates: Partial<AgentState>): void {
  const current = getState();
  const merged = { ...current, ...updates };
  const statePath = getStatePath();
  const tmpPath = statePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmpPath, statePath);
}
