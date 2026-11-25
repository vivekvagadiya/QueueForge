import os from 'node:os';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { closeDatabase } from './config/database.js';
import { closeRedisClient } from './config/redis.js';
import { registerShutdownHandlers } from './utils/shutdown.js';

const KEEPALIVE_INTERVAL_MS = 60_000;

let keepAliveTimer = null;

const startWorker = async () => {
  logger.info(
    {
      pid: process.pid,
      hostname: os.hostname(),
    },
    'QueueForge worker started'
  );

  // Maintain an active event-loop handle until Redis Streams polling is implemented.
  keepAliveTimer = setInterval(() => {
    logger.debug({ pid: process.pid }, 'Worker lifecycle heartbeat');
  }, KEEPALIVE_INTERVAL_MS);
};

const stopWorker = async () => {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  await Promise.allSettled([closeDatabase(), closeRedisClient()]);
};

registerShutdownHandlers({
  logger,
  onShutdown: stopWorker,
});

startWorker().catch((err) => {
  logger.fatal({ err }, 'Failed to start QueueForge worker');
  process.exit(1);
});
