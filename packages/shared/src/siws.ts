// SIWS canonical message builder + verifier moved to
// `@metaplex-foundation/plexchat` so the chat UI signs the exact same bytes the
// server verifies. Re-exported here to keep the existing
// `@metaplex-foundation/shared` import surface stable.
export {
  buildSiwsMessage,
  verifySiwsSignature,
  type SiwsParams,
  type VerifySiwsParams,
} from '@metaplex-foundation/plexchat';
