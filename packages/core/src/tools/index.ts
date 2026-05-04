import { sharedTools } from './shared/index.js';
import { publicTools } from './public/index.js';
import { autonomousOnlyTools } from './autonomous/index.js';

export const publicAgentTools = {
  ...sharedTools,
  ...publicTools,
};

// Autonomous agents get shared tools plus the goals/tasks/pause toolset
// for managing their own working memory, plus withdraw tools for moving
// funds out of their operational wallet.
export const autonomousAgentTools = {
  ...sharedTools,
  ...autonomousOnlyTools,
};

export { sharedTools, publicTools, autonomousOnlyTools };

export const publicToolNames = Object.keys(publicAgentTools);
export const autonomousToolNames = Object.keys(autonomousAgentTools);
