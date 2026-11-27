import { env } from './config/env.js';
import { logger as rootLogger } from './config/logger.js';
import { closeDatabase } from './config/database.js';
import { initDatabase } from './database/bootstrap.js';
import { RecoveryService } from './recovery/recoveryService.js';

/**
 * Recovery process: `npm run recovery`. Releases due retries, recovers jobs
 * whose worker lease expired, and marks silent workers UNHEALTHY.
 * PostgreSQL only; several instances may run safely.
 */
const SHUTDOWN_TIMEOUT_MS = 15_000;

const logger = rootLogger.child({ role: 'recovery' });

await initDatabase('recovery');

const service = new RecoveryService({
  logger,
  config: {
    intervalMs: env.RECOVERY_INTERVAL_MS,
    batchSize: env.RECOVERY_BATCH_SIZE,
    heartbeatTimeoutMs: env.WORKER_HEARTBEAT_TIMEOUT_MS,
    retryBaseMs: env.JOB_RETRY_BASE_MS,
    retryMaxMs: env.JOB_RETRY_MAX_MS,
  },
});

service.start();
console.info(`[QueueForge recovery] Running (pid=${process.pid}, interval=${env.RECOVERY_INTERVAL_MS}ms)`);

let shuttingDown = false;
const shutdown = async (signal, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down recovery service');

  const forceTimer = setTimeout(() => {
    logger.error('Forced recovery shutdown');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  await service.stop();
  await closeDatabase().catch(() => {});
  clearTimeout(forceTimer);
  console.info(`[QueueForge recovery] Stopped (pid=${process.pid})`);
  process.exit(exitCode);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  shutdown('uncaughtException', 1);
});
