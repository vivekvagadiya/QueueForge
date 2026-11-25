import os from 'node:os';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { closeDatabase } from './config/database.js';
import { closeRedisClient } from './config/redis.js';
import { registerShutdownHandlers } from './utils/shutdown.js';

const KEEPALIVE_INTERVAL_MS = 60_000;

let keepAliveTimer = null;

const startWorker = async () => {
  const instanceMeta = {
    pid: process.pid,
    hostname: os.hostname(),
    nodeVersion: process.version,
    databaseConfigured: Boolean(env.DATABASE_URL),
    redisConfigured: Boolean(env.REDIS_URL),
    heartbeatIntervalMs: KEEPALIVE_INTERVAL_MS,
  };

  logger.info(instanceMeta, 'QueueForge worker started');
  console.info(
    [
      '',
      `[QueueForge Worker] Instance running (${env.NODE_ENV})`,
      `  PID / Host : ${instanceMeta.pid} @ ${instanceMeta.hostname} (${instanceMeta.nodeVersion})`,
      `  Status     : Idle lifecycle active (heartbeat every ${KEEPALIVE_INTERVAL_MS / 1000}s)`,
      `  Database   : ${instanceMeta.databaseConfigured ? 'configured' : 'not configured'}`,
      `  Redis      : ${instanceMeta.redisConfigured ? 'configured' : 'not configured'}`,
      '',
    ].join('\n')
  );

  // Maintain an active event-loop handle until Redis Streams polling is implemented.
  keepAliveTimer = setInterval(() => {
    logger.debug({ pid: process.pid }, 'Worker lifecycle heartbeat');
  }, KEEPALIVE_INTERVAL_MS);
};

const stopWorker = async () => {
  console.info(`[QueueForge Worker] Stopping instance (pid=${process.pid})...`);
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  await Promise.allSettled([closeDatabase(), closeRedisClient()]);
  console.info(`[QueueForge Worker] Instance stopped (pid=${process.pid})`);
};

registerShutdownHandlers({
  logger,
  onShutdown: stopWorker,
});

startWorker().catch((err) => {
  logger.fatal({ err }, 'Failed to start QueueForge worker');
  process.exit(1);
});
