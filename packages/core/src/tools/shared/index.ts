import { withAuth } from '@metaplex-agent/shared';
import { getBalance } from './get-balance.js';
import { getTokenBalances } from './get-token-balances.js';
import { getTransaction } from './get-transaction.js';
import { getTokenPrice } from './get-token-price.js';
import { getTokenMetadata } from './get-token-metadata.js';
import { sleep } from './sleep.js';
import { registerAgent } from './register-agent.js';
import { delegateExecution } from './delegate-execution.js';
import { launchToken } from './launch-token.js';
import { swapToken } from './swap-token.js';
import { buybackToken } from './buyback-token.js';
import { sellToken } from './sell-token.js';

export const sharedTools = {
  getBalance:        withAuth(getBalance, 'public'),
  getTokenBalances:  withAuth(getTokenBalances, 'public'),
  getTransaction:    withAuth(getTransaction, 'public'),
  getTokenPrice:     withAuth(getTokenPrice, 'public'),
  getTokenMetadata:  withAuth(getTokenMetadata, 'public'),
  sleep:             withAuth(sleep, 'public'),
  registerAgent:     withAuth(registerAgent, 'owner'),
  delegateExecution: withAuth(delegateExecution, 'owner'),
  launchToken:       withAuth(launchToken, 'owner'),
  swapToken:         withAuth(swapToken, 'owner'),
  buybackToken:      withAuth(buybackToken, 'owner'),
  sellToken:         withAuth(sellToken, 'owner'),
};

export {
  getBalance, getTokenBalances, getTransaction, getTokenPrice, getTokenMetadata, sleep,
  registerAgent, delegateExecution, launchToken, swapToken, buybackToken, sellToken,
};
