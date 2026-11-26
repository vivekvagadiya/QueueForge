import { env } from './config/env.js';
import { logger as rootLogger } from './config/logger.js';
import { closeDatabase } from './config/database.js';
import { closeRedis, createRedisClient } from './config/redis.js';
import { initDatabase } from './database/bootstrap.js';
import { OutboxPublisher } from './outbox/outboxPublisher.js';
import { outboxRepository } from './repositories/outbox.repository.js';

/**
 * Outbox publisher process: `npm run publisher`.
 * Runs separately from the API and can be scaled to several instances;
 * SKIP LOCKED claiming keeps them from publishing the same batch.
 */
const SHUTDOWN_TIMEOUT_MS = 15_000;
const STATS_INTERVAL_MS = 30_000;

const logger = rootLogger.child({ role: 'publisher' });

await initDatabase('publisher');

const redis = createRedisClient('publisher');

const publisher = new OutboxPublisher({
  redis,
  logger,
  config: {
    pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    batchSize: env.OUTBOX_BATCH_SIZE,
    claimTimeoutMs: env.OUTBOX_CLAIM_TIMEOUT_MS,
    baseMs: env.OUTBOX_RETRY_BASE_MS,
    maxMs: env.OUTBOX_RETRY_MAX_MS,
  },
});

publisher.start();
console.info(
  `[QueueForge publisher] Running (pid=${process.pid}, id=${publisher.publisherId}, stream prefix=${env.STREAM_PREFIX})`
);

// Periodic backlog log: a growing oldest-unpublished age means publishing is falling behind.
const statsTimer = setInterval(async () => {
  try {
    logger.info(await outboxRepository.stats(), 'Outbox backlog');
  } catch (err) {
    logger.warn({ err }, 'Could not read outbox stats');
  }
}, STATS_INTERVAL_MS);
statsTimer.unref();

let shuttingDown = false;
const shutdown = async (signal, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down outbox publisher');

  const forceTimer = setTimeout(() => {
    logger.error('Forced publisher shutdown; in-flight claims will be recovered after the claim timeout');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  clearInterval(statsTimer);
  await publisher.stop();
  await Promise.allSettled([closeRedis(redis), closeDatabase()]);
  clearTimeout(forceTimer);
  console.info(`[QueueForge publisher] Stopped (pid=${process.pid})`);
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
