import Redis from 'ioredis';
import { env } from './env.js';
import { logger } from './logger.js';

let redisClient = null;

export const getRedisClient = () => {
  if (redisClient) {
    return redisClient;
  }

  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL is not configured');
  }

  redisClient = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });

  redisClient.on('error', (err) => {
    logger.error({ err }, 'Redis client error');
  });

  return redisClient;
};

export const closeRedisClient = async () => {
  if (!redisClient) {
    return;
  }

  if (redisClient.status !== 'end') {
    await redisClient.quit();
  }

  redisClient = null;
  logger.info('Redis connection closed');
};
