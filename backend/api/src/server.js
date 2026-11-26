import os from 'node:os';
import app from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { getDatabase, closeDatabase } from './config/database.js';
import { createMigrator } from './database/umzug.js';
import { initModels } from './models/index.js';
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

/**
 * Verifies PostgreSQL is reachable and the schema is fully migrated.
 * Exits with a clear message instead of serving requests against a bad database.
 */
const initDatabase = async () => {
  const sequelize = getDatabase();

  try {
    await sequelize.authenticate();
  } catch (err) {
    logger.fatal({ err: err.original ?? err }, 'Cannot connect to PostgreSQL');
    console.error(
      `[QueueForge API] Startup aborted: cannot connect to PostgreSQL (${err.original?.code ?? err.message}). ` +
        'Check DATABASE_URL and that the database server is running.'
    );
    await closeDatabase();
    process.exit(1);
  }

  const pending = await createMigrator(sequelize).pending();
  if (pending.length > 0) {
    const names = pending.map((m) => m.name);
    logger.fatal({ pending: names }, 'Database has pending migrations');
    console.error(
      `[QueueForge API] Startup aborted: ${pending.length} pending migration(s): ${names.join(', ')}. ` +
        'Run `npm run db:migrate`.'
    );
    await closeDatabase();
    process.exit(1);
  }

  initModels(sequelize);
  logger.info('PostgreSQL connected and schema up to date');
};

await initDatabase();

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
