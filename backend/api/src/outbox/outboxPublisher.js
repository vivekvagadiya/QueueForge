import crypto from 'node:crypto';
import os from 'node:os';
import { isRedisReady } from '../config/redis.js';
import { outboxRepository } from '../repositories/outbox.repository.js';
import { jobStreamKey, toStreamFields } from '../streams/jobStream.js';
import { retryDelayMs } from '../utils/backoff.js';

export const createPublisherId = () =>
  `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

/**
 * Moves committed outbox events to Redis Streams.
 *
 * Cycle: claim a batch in PostgreSQL -> XADD each event -> mark the successful
 * ones PUBLISHED, and release failed ones back to PENDING with backoff.
 *
 * Guarantees:
 * - An event is marked PUBLISHED only after Redis acknowledged the XADD.
 * - A crash after XADD but before marking leaves the event claimed; after the
 *   claim timeout another publisher re-publishes it. Duplicate stream entries
 *   are therefore possible and consumers must tolerate them.
 * - While Redis is unreachable, nothing is claimed and events stay PENDING.
 */
export class OutboxPublisher {
  constructor({ redis, config, logger, publisherId = createPublisherId(), repository = outboxRepository }) {
    this.redis = redis;
    this.config = config;
    this.logger = logger.child({ publisherId });
    this.publisherId = publisherId;
    this.repository = repository;
    this.running = false;
    this.wake = null;
    this.loopPromise = null;
    this.waitingForRedis = false;
  }

  /** Runs one claim/publish cycle. Returns counts for logging and tests. */
  async runOnce() {
    if (!isRedisReady(this.redis)) {
      if (!this.waitingForRedis) {
        this.waitingForRedis = true;
        this.logger.warn({ redisStatus: this.redis.status }, 'Redis not ready; outbox events stay pending');
      }
      return { claimed: 0, published: 0, failed: 0, lost: 0, skipped: true };
    }
    if (this.waitingForRedis) {
      this.waitingForRedis = false;
      this.logger.info('Redis ready; resuming outbox publishing');
    }

    const events = await this.repository.claimBatch({
      publisherId: this.publisherId,
      limit: this.config.batchSize,
      claimTimeoutMs: this.config.claimTimeoutMs,
    });
    if (events.length === 0) {
      return { claimed: 0, published: 0, failed: 0, lost: 0 };
    }

    const published = [];
    let failed = 0;
    let lost = 0;

    for (const event of events) {
      try {
        const streamId = await this.redis.xadd(
          jobStreamKey(event.payload.queueId),
          '*',
          ...toStreamFields(event)
        );
        published.push({ id: event.id, streamId });
      } catch (err) {
        failed += 1;
        const delay = retryDelayMs(event.attempts, this.config);
        const released = await this.repository.markFailed({
          publisherId: this.publisherId,
          id: event.id,
          error: err.message,
          retryDelayMs: delay,
        });
        if (!released) lost += 1;
        this.logger.warn(
          { err, eventId: event.id, attempts: event.attempts, retryInMs: delay },
          'Outbox publish failed; will retry'
        );
      }
    }

    const marked = await this.repository.markPublished({ publisherId: this.publisherId, published });
    if (marked.length !== published.length) {
      lost += published.length - marked.length;
      const markedSet = new Set(marked);
      this.logger.warn(
        { eventIds: published.filter((p) => !markedSet.has(p.id)).map((p) => p.id) },
        'Published events whose claim was lost; another publisher may publish them again'
      );
    }

    const result = { claimed: events.length, published: marked.length, failed, lost };
    this.logger.debug(result, 'Outbox cycle complete');
    return result;
  }

  /** Starts the polling loop. A full batch triggers the next cycle immediately. */
  start() {
    if (this.running) return;
    this.running = true;
    this.logger.info({ config: this.config }, 'Outbox publisher started');

    this.loopPromise = (async () => {
      let consecutiveErrors = 0;
      while (this.running) {
        let delay = this.config.pollIntervalMs;
        try {
          const { claimed } = await this.runOnce();
          consecutiveErrors = 0;
          if (claimed === this.config.batchSize) delay = 0;
        } catch (err) {
          // Typically a database error. Back off; claimed events recover via the claim timeout.
          consecutiveErrors += 1;
          delay = retryDelayMs(consecutiveErrors, this.config);
          this.logger.error({ err, retryInMs: delay }, 'Outbox publisher cycle failed');
        }
        if (this.running && delay > 0) await this.sleep(delay);
      }
    })();
  }

  /** Stops after the current cycle finishes. */
  async stop() {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loopPromise;
    this.logger.info('Outbox publisher stopped');
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}
