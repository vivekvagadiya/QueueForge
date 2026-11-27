import { isRedisReady } from '../config/redis.js';
import { withCorrelationId } from '../observability/context.js';
import { retentionDeletedTotal } from '../observability/metrics.js';
import { retentionRepository } from '../repositories/retention.repository.js';
import { jobStreamKey } from '../streams/jobStream.js';
import { retryDelayMs } from '../utils/backoff.js';

// Bounded work per category per pass; a full pass schedules the next one immediately.
const MAX_BATCHES_PER_PASS = 10;
const WORKER_CONSUMER = /^worker:([0-9a-f-]{36})$/i;

// --- Redis stream ID helpers ("<ms>-<seq>") -----------------------------------
const parseId = (id) => {
  const [ms, seq = '0'] = String(id).split('-');
  return [BigInt(ms), BigInt(seq)];
};
export const compareStreamIds = (a, b) => {
  const [am, as] = parseId(a);
  const [bm, bs] = parseId(b);
  if (am !== bm) return am < bm ? -1 : 1;
  if (as !== bs) return as < bs ? -1 : 1;
  return 0;
};
const minId = (a, b) => (compareStreamIds(a, b) <= 0 ? a : b);
const successor = (id) => {
  const [ms, seq] = parseId(id);
  return `${ms}-${seq + 1n}`;
};
/** ioredis returns XINFO replies as flat [key, value, ...] arrays. */
const toObject = (flat) => {
  const out = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
};

/**
 * Retention, run by the recovery process every `intervalMs`:
 *
 * PostgreSQL (an age of 0 disables a category):
 * - COMPLETED jobs older than `completedJobMs`, FAILED/DEAD/CANCELLED jobs
 *   older than `failedJobMs` (by completed_at). Attempts go with their job.
 * - PUBLISHED outbox events older than `outboxMs`.
 *
 * Redis (skipped while Redis is unavailable):
 * - Each queue stream is trimmed with XTRIM MINID to the oldest entry that is
 *   still needed: nothing at or after any group's oldest pending entry or
 *   first undelivered entry is removed, and acknowledged entries are kept
 *   for `streamMs` for debugging. Streams without a consumer group are left alone.
 * - Consumers with no pending entries, idle longer than `consumerMs`, whose
 *   worker row is STOPPED, gone, or silent for `consumerMs`, are deleted.
 */
export class RetentionService {
  constructor({ config, logger, redis = null, repository = retentionRepository }) {
    // { intervalMs, batchSize, completedJobMs, failedJobMs, outboxMs, streamMs, consumerMs }
    this.config = config;
    this.logger = logger;
    this.redis = redis;
    this.repository = repository;
    this.running = false;
    this.wake = null;
    this.loopPromise = null;
  }

  async purge(fn, olderThanMs) {
    if (!olderThanMs) return 0;
    let total = 0;
    for (let i = 0; i < MAX_BATCHES_PER_PASS; i += 1) {
      const deleted = await fn({ olderThanMs, limit: this.config.batchSize });
      total += deleted;
      if (deleted < this.config.batchSize) break;
    }
    return total;
  }

  async runOnce() {
    const { completedJobMs, failedJobMs, outboxMs } = this.config;
    const result = {
      completedJobs: await this.purge(this.repository.deleteCompletedJobs, completedJobMs),
      failedJobs: await this.purge(this.repository.deleteFailedJobs, failedJobMs),
      outboxEvents: await this.purge(this.repository.deletePublishedOutboxEvents, outboxMs),
      streamEntries: 0,
      consumers: 0,
      streamsSkipped: false,
    };

    if (isRedisReady(this.redis)) {
      const streams = await this.maintainStreams();
      result.streamEntries = streams.trimmed;
      result.consumers = streams.consumers;
    } else if (this.redis) {
      result.streamsSkipped = true;
    }

    for (const kind of ['completedJobs', 'failedJobs', 'outboxEvents', 'streamEntries', 'consumers']) {
      if (result[kind] > 0) retentionDeletedTotal.inc({ kind }, result[kind]);
    }
    const removed = result.completedJobs + result.failedJobs + result.outboxEvents + result.streamEntries + result.consumers;
    if (removed > 0) this.logger.info(result, 'Retention pass removed old data');
    return result;
  }

  async maintainStreams() {
    const queueIds = await this.repository.listAllQueueIds();
    const [sec, micro] = await this.redis.time();
    const nowMs = Number(sec) * 1000 + Math.floor(Number(micro) / 1000);
    let trimmed = 0;
    let consumers = 0;
    for (const queueId of queueIds) {
      const r = await this.maintainStream(jobStreamKey(queueId), nowMs);
      trimmed += r.trimmed;
      consumers += r.consumers;
    }
    return { trimmed, consumers };
  }

  /** Trims one stream and removes its retired consumers. */
  async maintainStream(key, nowMs) {
    let groups;
    try {
      groups = (await this.redis.xinfo('GROUPS', key)).map(toObject);
    } catch (err) {
      if (/no such key/i.test(err.message)) return { trimmed: 0, consumers: 0 };
      throw err;
    }
    if (groups.length === 0) return { trimmed: 0, consumers: 0 }; // nothing consumed yet

    const { streamMs, consumerMs } = this.config;
    let bound = streamMs > 0 ? `${Math.max(0, nowMs - streamMs)}-0` : null;
    let consumersRemoved = 0;

    for (const group of groups) {
      // last-delivered-id (L) was read before XPENDING. An entry delivered after
      // that read has an ID above L, and the bound never exceeds L + 1, so it is
      // safe. Entries pending at the XPENDING call are protected by the smallest
      // pending ID; ones acknowledged in between may go, which is correct.
      if (Number(group.pending) > 0) {
        const [, smallestPending] = await this.redis.xpending(key, group.name);
        if (smallestPending && bound) bound = minId(bound, smallestPending);
      }
      if (bound) bound = minId(bound, successor(group['last-delivered-id']));

      if (consumerMs > 0) {
        consumersRemoved += await this.removeRetiredConsumers(key, group.name, consumerMs);
      }
    }

    const trimmed = bound ? Number(await this.redis.xtrim(key, 'MINID', bound)) : 0;
    return { trimmed, consumers: consumersRemoved };
  }

  async removeRetiredConsumers(key, group, consumerMs) {
    const candidates = (await this.redis.xinfo('CONSUMERS', key, group))
      .map(toObject)
      .filter((c) => Number(c.pending) === 0 && Number(c.idle) > consumerMs)
      .map((c) => ({ name: c.name, workerId: WORKER_CONSUMER.exec(c.name)?.[1] }))
      .filter((c) => c.workerId); // only consumers this system created

    if (candidates.length === 0) return 0;
    const live = await this.repository.findLiveWorkerIds({
      workerIds: candidates.map((c) => c.workerId),
      withinMs: consumerMs,
    });

    let removed = 0;
    for (const c of candidates) {
      if (live.has(c.workerId)) continue;
      // DELCONSUMER also drops the consumer's pending entries; re-check right before.
      const [current] = (await this.redis.xinfo('CONSUMERS', key, group))
        .map(toObject)
        .filter((x) => x.name === c.name);
      if (!current || Number(current.pending) !== 0) continue;
      await this.redis.xgroup('DELCONSUMER', key, group, c.name);
      removed += 1;
      this.logger.info({ stream: key, consumer: c.name }, 'Deleted retired stream consumer');
    }
    return removed;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.logger.info({ config: this.config }, 'Retention service started');

    this.loopPromise = (async () => {
      let consecutiveErrors = 0;
      while (this.running) {
        let wait = this.config.intervalMs;
        try {
          const r = await withCorrelationId(null, () => this.runOnce());
          consecutiveErrors = 0;
          const limit = this.config.batchSize * MAX_BATCHES_PER_PASS;
          if ([r.completedJobs, r.failedJobs, r.outboxEvents].includes(limit)) wait = 0;
        } catch (err) {
          consecutiveErrors += 1;
          wait = retryDelayMs(consecutiveErrors, { baseMs: 1000, maxMs: this.config.intervalMs });
          this.logger.error({ err, retryInMs: wait }, 'Retention pass failed');
        }
        if (this.running && wait > 0) await this.sleep(wait);
      }
    })();
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loopPromise;
    this.logger.info('Retention service stopped');
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
