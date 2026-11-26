import Redis from 'ioredis';
import { env } from './env.js';
import { logger } from './logger.js';

const RECONNECT_BASE_MS = 200;
const RECONNECT_MAX_MS = 5000;

/**
 * Creates a Redis client with bounded reconnect backoff and connection-state
 * logging. Defaults are for request/response commands that must fail fast
 * while Redis is down (no offline queue), so callers can retry on their own
 * terms instead of piling up commands in memory. Blocking consumers (Sprint 3
 * workers) should pass their own overrides.
 */
export const createRedisClient = (name, overrides = {}) => {
  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL is not configured');
  }

  const log = logger.child({ redisClient: name });
  const client = new Redis(env.REDIS_URL, {
    connectionName: `queueforge:${name}`,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    commandTimeout: 5000,
    retryStrategy: (times) => Math.min(RECONNECT_BASE_MS * 2 ** (times - 1), RECONNECT_MAX_MS),
    ...overrides,
  });

  let lastErrorCode = null;
  client.on('ready', () => {
    lastErrorCode = null;
    log.info('Redis connection ready');
  });
  client.on('error', (err) => {
    // Avoid logging the same connection error on every reconnect attempt.
    if (err.code !== lastErrorCode) {
      lastErrorCode = err.code;
      log.error({ err }, 'Redis client error');
    }
  });
  client.on('reconnecting', (delay) => log.debug({ delay }, 'Redis reconnecting'));
  client.on('end', () => log.info('Redis connection closed'));

  return client;
};

export const isRedisReady = (client) => client?.status === 'ready';

/** Health check: true when Redis answers PING within the command timeout. */
export const pingRedis = async (client) => {
  try {
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  }
};

export const closeRedis = async (client) => {
  if (!client || client.status === 'end') {
    return;
  }
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
};

// Shared client for the API process (not used by request handlers yet).
let sharedClient = null;

export const getRedisClient = () => {
  sharedClient ??= createRedisClient('api');
  return sharedClient;
};

export const closeRedisClient = async () => {
  await closeRedis(sharedClient);
  sharedClient = null;
};
