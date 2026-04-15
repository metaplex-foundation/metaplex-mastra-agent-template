import { registerAgent } from './register-agent.js';
import { delegateExecution } from './delegate-execution.js';
import { launchToken } from './launch-token.js';
import { swapToken } from './swap-token.js';
import { buybackToken } from './buyback-token.js';
import { sellToken } from './sell-token.js';

export const autonomousTools = {
  registerAgent,
  delegateExecution,
  launchToken,
  swapToken,
  buybackToken,
  sellToken,
};

export { registerAgent, delegateExecution, launchToken, swapToken, buybackToken, sellToken };
