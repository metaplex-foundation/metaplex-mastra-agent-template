import { withAuth } from '@metaplex-foundation/shared';
import { transferSol } from './transfer-sol.js';
import { transferToken } from './transfer-token.js';

export const publicTools = {
  transferSol:   withAuth(transferSol, 'public'),
  transferToken: withAuth(transferToken, 'public'),
};

export { transferSol, transferToken };
