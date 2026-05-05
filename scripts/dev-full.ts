#!/usr/bin/env tsx
/**
 * One-command dev: agent server + chat UI together.
 *
 * - Boots the agent's `pnpm dev` in this repo
 * - Boots the chat UI's `pnpm dev` in the sibling `../metaplex-agent-chat-template`
 *
 * If the chat-template sibling doesn't exist, this script clones it (HTTPS,
 * shallow) and runs `pnpm install` once. Subsequent runs are no-ops on that
 * front and just exec the two dev processes via `concurrently`.
 *
 * Override the chat-template location with CHAT_TEMPLATE_DIR=...
 * Override the upstream URL with CHAT_TEMPLATE_REPO=https://...
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const CHAT_TEMPLATE_DIR = process.env.CHAT_TEMPLATE_DIR
  ?? resolve(ROOT, '..', 'metaplex-agent-chat-template');
const CHAT_TEMPLATE_REPO = process.env.CHAT_TEMPLATE_REPO
  ?? 'https://github.com/metaplex-foundation/metaplex-agent-chat-template.git';

function log(...args: unknown[]): void {
  console.log('[dev:full]', ...args);
}

function ensureChatTemplate(): void {
  if (existsSync(CHAT_TEMPLATE_DIR)) {
    log(`chat-template found at ${CHAT_TEMPLATE_DIR}`);
    return;
  }
  log(`chat-template missing at ${CHAT_TEMPLATE_DIR}`);
  log(`cloning from ${CHAT_TEMPLATE_REPO} ...`);
  try {
    execSync(`git clone --depth 1 ${CHAT_TEMPLATE_REPO} ${CHAT_TEMPLATE_DIR}`, {
      stdio: 'inherit',
    });
  } catch {
    console.error(
      `[dev:full] clone failed. Either:\n` +
      `  1. Set CHAT_TEMPLATE_DIR to a local checkout you already have, or\n` +
      `  2. Manually run: git clone ${CHAT_TEMPLATE_REPO} ${CHAT_TEMPLATE_DIR}\n` +
      `  3. Run \`pnpm dev\` here (server-only) and use any other PlexChat client.`,
    );
    process.exit(1);
  }
  log('installing chat-template deps (one-time)...');
  execSync('pnpm install', { cwd: CHAT_TEMPLATE_DIR, stdio: 'inherit' });
  if (!existsSync(resolve(CHAT_TEMPLATE_DIR, '.env.local'))) {
    const example = resolve(CHAT_TEMPLATE_DIR, '.env.local.example');
    if (existsSync(example)) {
      execSync(`cp ${example} ${resolve(CHAT_TEMPLATE_DIR, '.env.local')}`);
      log('seeded chat-template .env.local from .env.local.example');
    }
  }
}

function run(): void {
  // Use the locally-installed concurrently binary so users don't need it
  // globally. spawn() with shell: true so the binary resolves via PATH that
  // pnpm has populated.
  const child = spawn(
    'pnpm',
    [
      'exec',
      'concurrently',
      '--kill-others-on-fail',
      '--names', 'agent,ui',
      '--prefix-colors', 'cyan,magenta',
      'pnpm dev',
      `pnpm --dir ${JSON.stringify(CHAT_TEMPLATE_DIR)} dev`,
    ],
    { stdio: 'inherit', cwd: ROOT, shell: false },
  );
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => child.kill(sig));
  }
}

ensureChatTemplate();
run();
