import { getConfig } from '@metaplex-agent/shared';
import { PlexChatServer } from './websocket.js';
import { WorkerLoop } from './worker-loop.js';

const config = getConfig();
const server = new PlexChatServer();
let workerLoop: WorkerLoop | null = null;

async function bootstrap(): Promise<void> {
  await server.start();

  // The WS server resolves the on-chain owner asynchronously after listen().
  // The worker loop needs that owner so its tick-mode requestContext can
  // authorize 'owner'-gated tools (set-goal, etc). Wait before booting.
  if (config.AGENT_MODE === 'autonomous') {
    await server.whenReady();
    const owner = server.getOwnerWallet();
    if (!owner) {
      console.warn(
        '[worker-loop] no owner resolved at startup; loop will idle until ' +
        'resolution succeeds. (Restart after the on-chain asset is reachable.)',
      );
      return;
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
