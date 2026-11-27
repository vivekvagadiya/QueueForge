import { env } from './config/env.js';
import { logger as rootLogger } from './config/logger.js';
import { closeDatabase } from './config/database.js';
import { closeRedis, createRedisClient } from './config/redis.js';
import { initDatabase } from './database/bootstrap.js';
import { RecoveryService } from './recovery/recoveryService.js';
import { RetentionService } from './recovery/retentionService.js';

/**
 * Recovery process: `npm run recovery`. Releases due scheduled jobs and
 * retries, recovers jobs whose worker lease expired, marks silent workers
 * UNHEALTHY, and runs retention. Job state work is PostgreSQL only; Redis is
 * used just for stream trimming, which is skipped while Redis is down.
 * Several instances may run safely.
 */
const SHUTDOWN_TIMEOUT_MS = 15_000;

const logger = rootLogger.child({ role: 'recovery' });

await initDatabase('recovery');

const redis = createRedisClient('recovery');

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

const retention = new RetentionService({
  logger: logger.child({ component: 'retention' }),
  redis,
  config: {
    intervalMs: env.RETENTION_INTERVAL_MS,
    batchSize: env.RETENTION_BATCH_SIZE,
    completedJobMs: env.JOB_RETENTION_COMPLETED_MS,
    failedJobMs: env.JOB_RETENTION_FAILED_MS,
    outboxMs: env.OUTBOX_RETENTION_MS,
    streamMs: env.STREAM_RETENTION_MS,
    consumerMs: env.STREAM_CONSUMER_RETENTION_MS,
  },
});

service.start();
retention.start();
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

  await Promise.allSettled([service.stop(), retention.stop()]);
  await Promise.allSettled([closeRedis(redis), closeDatabase()]);
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
