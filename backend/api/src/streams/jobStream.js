import { env } from '../config/env.js';

/**
 * One Redis stream per queue, so workers can subscribe to the queues they serve
 * and per-queue controls (pause, concurrency) don't require filtering a shared stream.
 *
 * Entries are lightweight notifications. They carry IDs, never the job payload:
 * PostgreSQL stays the source of truth, and a consumer must load and atomically
 * claim the job there before executing it. The same job may appear more than
 * once in a stream (at-least-once publishing).
 */
export const jobStreamKey = (queueId) => `${env.STREAM_PREFIX}:queue:${queueId}:jobs`;

/**
 * Creates the worker consumer group on a stream if missing. Starts at ID 0 so
 * entries published before any worker existed are still delivered. MKSTREAM
 * creates the stream for queues that have no jobs yet.
 */
export const ensureConsumerGroup = async (redis, streamKey, group) => {
  try {
    await redis.xgroup('CREATE', streamKey, group, '0', 'MKSTREAM');
    return true;
  } catch (err) {
    if (String(err.message).includes('BUSYGROUP')) {
      return false;
    }
    throw err;
  }
};

/** Flat field/value list for XADD. Redis stream values are strings. */
export const toStreamFields = (event) => [
  'eventId', event.id,
  'eventType', event.eventType,
  'jobId', event.payload.jobId,
  'queueId', event.payload.queueId,
];

/** Inverse of toStreamFields, for consumers (Sprint 3) and tests. */
export const fromStreamFields = (fields) => {
  const entry = {};
  for (let i = 0; i < fields.length; i += 2) {
    entry[fields[i]] = fields[i + 1];
  }
  return entry;
};
