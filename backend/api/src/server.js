import app from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { closeDatabase } from './config/database.js';
import { closeRedisClient } from './config/redis.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

let isShuttingDown = false;

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'QueueForge API server started');
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
