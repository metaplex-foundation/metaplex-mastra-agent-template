import { withAuth } from '@metaplex-agent/shared';
import {
  setGoal,
  closeGoalTool,
  addTaskTool,
  closeTaskTool,
} from './goals-tasks.js';
import { setPausedTool } from './set-paused.js';
import { withdrawSol } from './withdraw-sol.js';

/**
 * Autonomous-mode-only tools:
 * - Working memory: goals (durable, owner-set), tasks (tactical, agent-set),
 *   pause flag (emergency stop). All gated to 'owner' — both the chat path
 *   (verified asset owner) and the worker loop can call them.
 * - Treasury: withdraw-sol moves SOL out of the agent's keypair or PDA.
 *   Owner-only — no public chat user should be able to drain the agent.
 */
export const autonomousOnlyTools = {
  setGoal:     withAuth(setGoal,        'owner'),
  closeGoal:   withAuth(closeGoalTool,  'owner'),
  addTask:     withAuth(addTaskTool,    'owner'),
  closeTask:   withAuth(closeTaskTool,  'owner'),
  setPaused:   withAuth(setPausedTool,  'owner'),
  withdrawSol: withAuth(withdrawSol,    'owner'),
};

export {
  setGoal,
  closeGoalTool,
  addTaskTool,
  closeTaskTool,
  setPausedTool,
  withdrawSol,
};
