import { sharedTools } from './shared/index.js';
import { publicTools } from './public/index.js';

export const publicAgentTools = {
  ...sharedTools,
  ...publicTools,
};

// Autonomous agents only get shared tools (no user-facing transfer tools)
export const autonomousAgentTools = {
  ...sharedTools,
};

export { sharedTools, publicTools };

export const publicToolNames = Object.keys(publicAgentTools);
export const autonomousToolNames = Object.keys(autonomousAgentTools);
