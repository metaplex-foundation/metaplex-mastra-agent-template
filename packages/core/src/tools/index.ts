import { sharedTools } from './shared/index.js';
import { publicTools } from './public/index.js';
import { autonomousTools } from './autonomous/index.js';

export const publicAgentTools = {
  ...sharedTools,
  ...publicTools,
};

export const autonomousAgentTools = {
  ...sharedTools,
  ...autonomousTools,
};

export { sharedTools, publicTools, autonomousTools };

export const publicToolNames = Object.keys(publicAgentTools);
export const autonomousToolNames = Object.keys(autonomousAgentTools);

// Re-export for backward compatibility
export const tools = publicAgentTools;
export const toolNames = publicToolNames;
