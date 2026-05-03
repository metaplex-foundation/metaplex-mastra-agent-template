import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  addGoal,
  addTask,
  appendJournal,
  closeGoal,
  closeTask,
  err,
  info,
  ok,
} from '@metaplex-agent/shared';

/**
 * Persist a goal the owner has briefed in chat. The agent should paraphrase
 * the owner's intent and call this only after the owner explicitly confirms
 * the wording — goals are durable contracts. The system prompt enforces this.
 */
export const setGoal = createTool({
  id: 'set-goal',
  description:
    'Persist a goal the owner has briefed. Only call after the owner has confirmed the exact wording — goals are durable contracts.',
  inputSchema: z.object({
    description: z
      .string()
      .min(1)
      .max(500)
      .describe('Clear, paraphrased statement of the goal as confirmed by the owner.'),
  }),
  outputSchema: z.object({
    status: z.string().optional(),
    code: z.string().optional(),
    goalId: z.string().optional(),
    description: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async ({ description }) => {
    const goal = addGoal(description);
    appendJournal({
      kind: 'goal_set',
      summary: `Goal set: ${description}`,
      txSigs: [],
    });
    return ok({
      goalId: goal.id,
      description: goal.description,
      message: `Goal recorded as ${goal.id}.`,
    });
  },
});

/**
 * Close a goal — either marking it achieved (the desired end-state was
 * reached) or abandoned (no longer pursued). Use the goal's id from
 * the active-goals list in the tick prompt or the chat-mode prefix.
 */
export const closeGoalTool = createTool({
  id: 'close-goal',
  description:
    'Mark an active goal as achieved (success) or abandoned (no longer pursued). Use the goal id from the active-goals list.',
  inputSchema: z.object({
    goalId: z.string().min(1).describe('The id of the goal to close (e.g. g_abcd1234).'),
    status: z
      .enum(['achieved', 'abandoned'])
      .describe("'achieved' if the goal was reached, 'abandoned' if dropped."),
    reason: z
      .string()
      .max(300)
      .optional()
      .describe('Short note on why the goal is closing — appended to the journal.'),
  }),
  outputSchema: z.object({
    status: z.string().optional(),
    code: z.string().optional(),
    goalId: z.string().optional(),
    finalStatus: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async ({ goalId, status, reason }) => {
    const goal = closeGoal(goalId, status);
    if (!goal) {
      return err('NOT_FOUND', `No goal found with id ${goalId}.`);
    }
    if (reason) {
      appendJournal({
        kind: 'tick',
        summary: `Goal ${goalId} ${status}: ${reason}`,
        txSigs: [],
      });
    }
    return ok({
      goalId: goal.id,
      finalStatus: goal.status,
      message: `Goal ${goalId} marked ${status}.`,
    });
  },
});

/**
 * Spawn a task the agent intends to act on, optionally linked to a goal.
 * Tasks are tactical — small, near-term work items the agent will pick up
 * in this tick or a future one. Free-floating tasks (no goalId) are fine
 * for one-off owner requests.
 */
export const addTaskTool = createTool({
  id: 'add-task',
  description:
    'Add a tactical task the agent intends to do, optionally linked to a goal. Tasks should be concrete and short-lived.',
  inputSchema: z.object({
    description: z
      .string()
      .min(1)
      .max(300)
      .describe('Concrete, actionable description of what the task is.'),
    goalId: z
      .string()
      .optional()
      .describe('Optional goal id this task contributes to. Omit for one-off tasks.'),
  }),
  outputSchema: z.object({
    status: z.string().optional(),
    code: z.string().optional(),
    taskId: z.string().optional(),
    description: z.string().optional(),
    goalId: z.string().nullable().optional(),
    message: z.string().optional(),
  }),
  execute: async ({ description, goalId }) => {
    const task = addTask(description, goalId ?? null);
    return ok({
      taskId: task.id,
      description: task.description,
      goalId: task.goalId,
      message: `Task recorded as ${task.id}.`,
    });
  },
});

/**
 * Mark a task done or failed. The result is a short summary that lands in
 * the journal — write something future-you will find useful one tick from
 * now (what was actually done, any number that matters).
 */
export const closeTaskTool = createTool({
  id: 'close-task',
  description:
    "Mark a task as done (succeeded) or failed (couldn't complete). Result is a short summary — what you actually did and any numbers that matter.",
  inputSchema: z.object({
    taskId: z.string().min(1).describe('The id of the task to close (e.g. t_abcd1234).'),
    status: z.enum(['done', 'failed']),
    result: z
      .string()
      .min(1)
      .max(300)
      .describe('Short summary — what happened, including any tx signatures or amounts.'),
  }),
  outputSchema: z.object({
    status: z.string().optional(),
    code: z.string().optional(),
    taskId: z.string().optional(),
    finalStatus: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async ({ taskId, status, result }) => {
    const task = closeTask(taskId, status, result);
    if (!task) {
      return err('NOT_FOUND', `No task found with id ${taskId}.`);
    }
    if (status === 'failed') {
      return info({
        taskId: task.id,
        finalStatus: task.status,
        message: `Task ${taskId} failed: ${result}`,
      });
    }
    return ok({
      taskId: task.id,
      finalStatus: task.status,
      message: `Task ${taskId} done.`,
    });
  },
});
