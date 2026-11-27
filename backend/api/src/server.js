import os from 'node:os';
import app from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { closeDatabase } from './config/database.js';
import { initDatabase } from './database/bootstrap.js';
import { closeRedisClient, getRedisClient } from './config/redis.js';
import { configureApiReadiness } from './controllers/health.controller.js';
import { registerClusterMetrics } from './observability/clusterMetrics.js';
import { postgresCheck, redisPingCheck, stateCheck } from './observability/health.js';
import { PgEventListener } from './realtime/pgEventListener.js';
import { createSocketServer } from './realtime/socketServer.js';

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

// Queue depth, waiting age, worker utilization and outbox backlog on /metrics.
registerClusterMetrics({ cacheMs: env.METRICS_CACHE_MS });

const server = app.listen(env.PORT, () => {
  logger.info(instanceMeta, 'QueueForge API server started');
  console.info(
    [
      '',
      `[QueueForge API] Instance running (${env.NODE_ENV})`,
      `  PID / Host : ${instanceMeta.pid} @ ${instanceMeta.hostname} (${instanceMeta.nodeVersion})`,
      `  Server URL : http://localhost:${env.PORT}`,
      `  Health URL : http://localhost:${env.PORT}/api/v1/health/ready`,
      `  Metrics URL: http://localhost:${env.PORT}/metrics`,
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

// Real-time updates (Sprint 6C): committed-state notifications from PostgreSQL
// relayed over Socket.IO. If the listener can't connect it keeps retrying; the
// REST API works regardless, since Socket.IO is only an enhancement.
const realtimeLogger = logger.child({ component: 'realtime' });
const eventListener = new PgEventListener({ connectionString: env.DATABASE_URL, logger: realtimeLogger });
const realtime = createSocketServer(server, {
  listener: eventListener,
  corsOrigin: env.corsOrigin,
  logger: realtimeLogger,
});
await eventListener.start();

// Readiness (GET /api/v1/health/ready): the API needs PostgreSQL to serve.
// Redis (only the publisher and workers depend on it) and the realtime
// listener are reported, and mark the API "degraded", without failing readiness.
const readiness = configureApiReadiness([
  postgresCheck(),
  redisPingCheck(env.REDIS_URL ? getRedisClient() : null, { critical: false }),
  stateCheck('realtime', () => eventListener.connected, { critical: false, code: 'NOT_CONNECTED' }),
]);

const shutdown = async (signal, exitCode = 0) => {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  readiness.markShuttingDown();

  logger.info({ signal }, 'Shutting down QueueForge API server');
  console.info(`[QueueForge API] Shutting down instance (pid=${process.pid}, signal=${signal})...`);

  const forceTimer = setTimeout(() => {
    logger.error('Forced API shutdown due to timeout');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  try {
    // Disconnects sockets and closes the HTTP server (see createSocketServer).
    await realtime.close();
    logger.info('HTTP and Socket.IO servers closed');

    await Promise.allSettled([eventListener.stop(), closeDatabase(), closeRedisClient()]);

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
