import { recoveryRepository } from '../repositories/recovery.repository.js';
import { retryDelayMs } from '../utils/backoff.js';

/**
 * Periodic maintenance that keeps jobs moving when workers fail:
 *
 * 1. Expired leases: ACTIVE jobs whose worker stopped renewing (crash, hang,
 *    lost database) -> attempt INTERRUPTED -> job RETRYING (backoff) or DEAD.
 * 2. Scheduler: SCHEDULED jobs (delayMs / scheduledAt) whose time has come
 *    -> WAITING + a new job.ready outbox event, in one transaction.
 * 3. Due retries: RETRYING jobs whose time has come -> WAITING + job.ready.
 * 4. Stale workers: no heartbeat for `heartbeatTimeoutMs` -> UNHEALTHY.
 *
 * Several instances can run at once; every step uses SKIP LOCKED claiming and
 * guarded updates. Stale workers can never overwrite recovered jobs because
 * every worker write is fenced on (locked_by, lease_version, status = ACTIVE).
 */
export class RecoveryService {
  constructor({ config, logger, repository = recoveryRepository }) {
    this.config = config; // { intervalMs, batchSize, heartbeatTimeoutMs, retryBaseMs, retryMaxMs }
    this.logger = logger;
    this.repository = repository;
    this.running = false;
    this.wake = null;
    this.loopPromise = null;
  }

  /** One pass over all steps. Returns counts for logging and tests. */
  async runOnce() {
    const { batchSize: limit, retryBaseMs, retryMaxMs, heartbeatTimeoutMs } = this.config;

    // Recover leases first so jobs recovered with a zero delay can be released in the same pass.
    const recovered = await this.repository.recoverExpiredLeases({ limit, retryBaseMs, retryMaxMs });
    for (const job of recovered) {
      this.logger.warn(
        { jobId: job.id, queueId: job.queue_id, attempt: job.attempts_made, previousOwner: job.locked_by,
          leaseVersion: job.lease_version, nextStatus: job.status },
        'Recovered job with an expired lease'
      );
    }

    const scheduled = await this.repository.releaseDueScheduled({ limit });
    if (scheduled.length > 0) {
      this.logger.info({ jobs: scheduled.length }, 'Released due scheduled jobs to WAITING');
    }

    const released = await this.repository.releaseDueRetries({ limit });
    if (released.length > 0) {
      this.logger.info({ jobs: released.length }, 'Released due retries to WAITING');
    }

    const stale = await this.repository.markStaleWorkers({ heartbeatTimeoutMs });
    for (const worker of stale) {
      this.logger.warn({ workerId: worker.id, name: worker.name }, 'Worker missed heartbeats; marked UNHEALTHY');
    }

    return {
      recovered: recovered.length,
      scheduled: scheduled.length,
      released: released.length,
      unhealthyWorkers: stale.length,
    };
  }

  /** Starts the loop. A full batch in any step triggers the next pass immediately. */
  start() {
    if (this.running) return;
    this.running = true;
    this.logger.info({ config: this.config }, 'Recovery service started');

    this.loopPromise = (async () => {
      let consecutiveErrors = 0;
      while (this.running) {
        let wait = this.config.intervalMs;
        try {
          const { recovered, scheduled, released } = await this.runOnce();
          consecutiveErrors = 0;
          if ([recovered, scheduled, released].includes(this.config.batchSize)) wait = 0;
        } catch (err) {
          consecutiveErrors += 1;
          wait = retryDelayMs(consecutiveErrors, { baseMs: this.config.intervalMs, maxMs: 30_000 });
          this.logger.error({ err, retryInMs: wait }, 'Recovery pass failed');
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
    this.logger.info('Recovery service stopped');
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
