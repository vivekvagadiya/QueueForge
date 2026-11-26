import os from 'node:os';
import app from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { closeDatabase } from './config/database.js';
import { initDatabase } from './database/bootstrap.js';
import { closeRedisClient } from './config/redis.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

let isShuttingDown = false;

const instanceMeta = {
  pid: process.pid,
  hostname: os.hostname(),
  nodeVersion: process.version,
  port: env.PORT,
  databaseConfigured: Boolean(env.DATABASE_URL),
  redisConfigured: Boolean(env.REDIS_URL),
};

await initDatabase('API');

const server = app.listen(env.PORT, () => {
  logger.info(instanceMeta, 'QueueForge API server started');
  console.info(
    [
      '',
      `[QueueForge API] Instance running (${env.NODE_ENV})`,
      `  PID / Host : ${instanceMeta.pid} @ ${instanceMeta.hostname} (${instanceMeta.nodeVersion})`,
      `  Server URL : http://localhost:${env.PORT}`,
      `  Health URL : http://localhost:${env.PORT}/api/v1/health`,
      `  CORS Origin: ${env.CORS_ORIGIN}`,
      `  Database   : ${instanceMeta.databaseConfigured ? 'configured' : 'not configured'}`,
      `  Redis      : ${instanceMeta.redisConfigured ? 'configured' : 'not configured'}`,
      '',
    ].join('\n')
  );
});

server.on('error', (err) => {
  logger.fatal({ err, port: env.PORT }, 'HTTP server error');
  process.exit(1);
});

const shutdown = async (signal, exitCode = 0) => {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  logger.info({ signal }, 'Shutting down QueueForge API server');
  console.info(`[QueueForge API] Shutting down instance (pid=${process.pid}, signal=${signal})...`);

  const forceTimer = setTimeout(() => {
    logger.error('Forced API shutdown due to timeout');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  try {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    logger.info('HTTP server closed');

    await Promise.allSettled([closeDatabase(), closeRedisClient()]);

    clearTimeout(forceTimer);
    logger.info('QueueForge API shutdown complete');
    console.info(`[QueueForge API] Instance stopped (pid=${process.pid})`);
    process.exit(exitCode);
  } catch (err) {
    clearTimeout(forceTimer);
    logger.error({ err }, 'Error during API shutdown');
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT', 0));
process.on('SIGTERM', () => shutdown('SIGTERM', 0));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  shutdown('uncaughtException', 1);
});
