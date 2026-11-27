import { env } from './config/env.js';
import { logger as rootLogger } from './config/logger.js';
import { closeDatabase } from './config/database.js';
import { closeRedis, createRedisClient } from './config/redis.js';
import { initDatabase } from './database/bootstrap.js';
import { createDefaultRegistry } from './worker/handlers/index.js';
import { Worker } from './worker/worker.js';

/**
 * Worker process: `npm run worker`. Run as many instances as needed; the
 * PostgreSQL claim guarantees a job is executed by one worker at a time.
 */
const logger = rootLogger.child({ role: 'worker' });

const parseQueueIds = (value) => {
  if (value === '*') return null;
  const ids = value.split(',').map((s) => s.trim()).filter(Boolean);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const invalid = ids.filter((id) => !uuid.test(id));
  if (invalid.length) {
    throw new Error(`WORKER_QUEUES must be "*" or comma-separated queue UUIDs; invalid: ${invalid.join(', ')}`);
  }
  return ids;
};

const config = {
  name: env.WORKER_NAME,
  group: env.CONSUMER_GROUP,
  queueIds: parseQueueIds(env.WORKER_QUEUES),
  queueRefreshMs: env.WORKER_QUEUE_REFRESH_MS,
  concurrency: env.WORKER_CONCURRENCY,
  blockMs: env.WORKER_BLOCK_MS,
  leaseMs: env.WORKER_LEASE_MS,
  leaseRenewMs: env.WORKER_LEASE_RENEW_MS ?? Math.floor(env.WORKER_LEASE_MS / 3),
  heartbeatMs: env.WORKER_HEARTBEAT_MS,
  pendingIdleMs: env.WORKER_PENDING_IDLE_MS,
  pendingCheckMs: env.WORKER_PENDING_CHECK_MS,
  shutdownGraceMs: env.WORKER_SHUTDOWN_GRACE_MS,
  retryBaseMs: env.JOB_RETRY_BASE_MS,
  retryMaxMs: env.JOB_RETRY_MAX_MS,
};

await initDatabase('worker');

// Blocking reads get their own connection, with a command timeout longer than BLOCK.
const reader = createRedisClient('worker-reader', { commandTimeout: env.WORKER_BLOCK_MS + 5000 });
const commands = createRedisClient('worker-commands');

const worker = new Worker({ reader, commands, registry: createDefaultRegistry(), logger, config });
await worker.start();
console.info(
  `[QueueForge worker] Running (pid=${process.pid}, id=${worker.workerId}, concurrency=${config.concurrency}, ` +
    `queues=${config.queueIds ? config.queueIds.length : 'all'})`
);

let shuttingDown = false;
const shutdown = async (signal, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down worker');

  // Hard stop if handlers ignore the abort signal.
  const forceTimer = setTimeout(() => {
    logger.error('Forced worker exit; unfinished jobs will be recovered when their leases expire (npm run recovery)');
    process.exit(1);
  }, config.shutdownGraceMs + 10_000);
  forceTimer.unref();

  await worker.stop();
  await Promise.allSettled([closeRedis(reader), closeRedis(commands), closeDatabase()]);
  clearTimeout(forceTimer);
  console.info(`[QueueForge worker] Stopped (pid=${process.pid})`);
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
