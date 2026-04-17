import { PlexChatServer } from './websocket.js';

const server = new PlexChatServer();
server.start().catch((err) => {
  console.error('Failed to start server:', err instanceof Error ? err.message : err);
  process.exit(1);
});

// --- Graceful shutdown (M7) ---
// Install signal handlers so SIGINT (Ctrl+C) / SIGTERM (docker/systemd)
// closes sockets, clears intervals, and aborts in-flight agent streams
// before the process exits.
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down gracefully...`);
  try {
    await server.stop();
  } catch (err) {
    console.error('Error during shutdown:', err instanceof Error ? err.message : err);
  }
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
