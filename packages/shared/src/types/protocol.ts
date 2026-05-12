// The PlexChat protocol now lives in the shared `@metaplex-foundation/plexchat`
// package so the chat UI can depend on the same definitions without
// vendoring a copy. Re-export here to preserve the existing
// `@metaplex-foundation/shared` import surface — no callers should need to
// change their imports.
export * from '@metaplex-foundation/plexchat';
