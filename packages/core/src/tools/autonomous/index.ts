import { withAuth } from '@metaplex-agent/shared';
import {
  setGoal,
  closeGoalTool,
  addTaskTool,
  closeTaskTool,
} from './goals-tasks.js';
import { setPausedTool } from './set-paused.js';

/**
 * Autonomous-mode-only tools for managing the agent's working memory:
 * goals (durable, owner-set), tasks (tactical, agent-set), and the
 * pause flag (emergency stop). All gated to 'owner' — both the chat
 * path (verified asset owner) and the worker loop (which constructs
 * an owner-equivalent context) can call them.
 */
export const autonomousOnlyTools = {
  setGoal:    withAuth(setGoal,        'owner'),
  closeGoal:  withAuth(closeGoalTool,  'owner'),
  addTask:    withAuth(addTaskTool,    'owner'),
  closeTask:  withAuth(closeTaskTool,  'owner'),
  setPaused:  withAuth(setPausedTool,  'owner'),
};

export {
  setGoal,
  closeGoalTool,
  addTaskTool,
  closeTaskTool,
  setPausedTool,
};
