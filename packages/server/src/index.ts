import { getConfig, resolveOwner } from '@metaplex-agent/shared';
import { PlexChatServer } from './websocket.js';
import { WorkerLoop } from './worker-loop.js';

const config = getConfig();
const server = new PlexChatServer();
let workerLoop: WorkerLoop | null = null;

/** Total time we'll spend waiting for owner resolution before giving up: ~70s.
 *  Backoff schedule: 5s, 10s, 15s, 20s, 30s.
 *  Pre-registration this is instant (returns BOOTSTRAP_WALLET); post-registration
 *  it depends on RPC reachability. If we can't resolve after this window the
 *  process exits so a supervisor (Docker, systemd, Railway) can restart. */
const OWNER_RETRY_BACKOFFS_MS = [5_000, 10_000, 15_000, 20_000, 30_000];

async function resolveOwnerWithRetry(): Promise<string | null> {
  // First attempt: piggy-back on whatever the WS server already resolved.
  let owner = server.getOwnerWallet();
  if (owner) return owner;

  for (const backoff of OWNER_RETRY_BACKOFFS_MS) {
    console.warn(
      `[worker-loop] owner not resolved yet; retrying in ${backoff / 1000}s ` +
      '(transient RPC error post-registration?)',
    );
    await new Promise((r) => setTimeout(r, backoff));
    owner = await resolveOwner(config.AGENT_ASSET_ADDRESS ?? null);
    if (owner) return owner;
  }
  return null;
}

async function bootstrap(): Promise<void> {
  await server.start();

  // The WS server resolves the on-chain owner asynchronously after listen().
  // The worker loop needs that owner so its tick-mode requestContext can
  // authorize 'owner'-gated tools (set-goal, etc). Wait before booting.
  if (config.AGENT_MODE === 'autonomous') {
    await server.whenReady();
    const owner = await resolveOwnerWithRetry();
    if (!owner) {
      console.error(
        '[worker-loop] failed to resolve owner after retries. Exiting so the ' +
        'supervisor can restart. Check SOLANA_RPC_URL reachability and that ' +
        'AGENT_ASSET_ADDRESS / BOOTSTRAP_WALLET are set correctly.',
      );
      process.exit(1);
    }
    workerLoop = new WorkerLoop(server.getAgent(), owner);
    workerLoop.start();
    const intervalSec = Math.round(config.TICK_INTERVAL_MS / 1000);
    const dryRun = config.AUTONOMOUS_DRY_RUN ? 'ENABLED' : 'disabled';
    console.log(
      `[worker-loop] started — interval=${intervalSec}s, txCap=${config.MAX_TICK_TX_COUNT}/tick, dryRun=${dryRun}`,
    );
  }
}

bootstrap().catch((err) => {
  console.error('Failed to start server:', err instanceof Error ? err.message : err);
  process.exit(1);
});

// --- Graceful shutdown (M7) ---
// Install signal handlers so SIGINT (Ctrl+C) / SIGTERM (docker/systemd)
// closes sockets, clears intervals, and aborts in-flight agent streams
// (chat path) and the worker loop (tick path) before the process exits.
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down gracefully...`);
  try {
    if (workerLoop) {
      await workerLoop.stop();
    }
    await server.stop();
  } catch (err) {
    console.error('Error during shutdown:', err instanceof Error ? err.message : err);
  }
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
