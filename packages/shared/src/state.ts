import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';

const STATE_FILENAME = 'agent-state.json';

export interface AgentState {
  agentAssetAddress?: string;
  agentTokenMint?: string;
}

/**
 * Find the state file by walking up from cwd (same logic as .env resolution).
 */
function findStateFile(from: string): string {
  let dir = from;
  while (true) {
    const candidate = resolve(dir, STATE_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Default: put it next to where .env would be (workspace root)
  // Walk up again looking for package.json with workspaces or .env
  dir = from;
  while (true) {
    if (existsSync(resolve(dir, '.env')) || existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      return resolve(dir, STATE_FILENAME);
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(from, STATE_FILENAME);
    dir = parent;
  }
}

let _statePath: string | null = null;

function getStatePath(): string {
  if (!_statePath) {
    _statePath = findStateFile(process.cwd());
  }
  return _statePath;
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
  writeFileSync(getStatePath(), JSON.stringify(merged, null, 2) + '\n');
}
