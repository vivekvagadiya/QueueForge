import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { isRedisReady } from '../config/redis.js';
import { jobExecutionRepository } from '../repositories/jobExecution.repository.js';
import { workerRepository } from '../repositories/worker.repository.js';
import { ensureConsumerGroup, fromStreamFields, jobStreamKey } from '../streams/jobStream.js';
import { retryDelayMs } from '../utils/backoff.js';
import { errorCode, isRetryable } from './errors.js';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'DEAD', 'CANCELLED']);

/**
 * Worker runtime. Consumes job.ready entries from per-queue Redis streams via a
 * consumer group, and executes jobs it has atomically claimed in PostgreSQL.
 *
 * Per entry:  claim in PG -> run handler (outside any transaction)
 *             -> persist outcome fenced by lease_version -> commit -> XACK.
 *
 * A Redis delivery never grants execution rights; only the PG claim does.
 * XACK happens only after the durable outcome commits, so a crash at any point
 * leaves the entry pending for redelivery/recovery (Sprint 4) rather than lost.
 *
 * Dependencies are injected so tests can drive single entries and simulate failures.
 */
export class Worker {
  constructor({
    reader,
    commands,
    registry,
    logger,
    config,
    repository = jobExecutionRepository,
    workers = workerRepository,
  }) {
    this.reader = reader; // dedicated connection for blocking XREADGROUP
    this.commands = commands; // XACK, XGROUP; never blocked by the reader
    this.registry = registry;
    this.baseLogger = logger;
    this.logger = logger;
    this.config = config;
    this.repository = repository;
    this.workers = workers;

    this.workerId = null;
    this.consumerName = null;
    this.streamKeys = [];
    this.queuesRefreshedAt = 0;
    this.running = false;
    this.waitingForRedis = false;
    this.loopPromise = null;
    this.inflight = new Set();
    // Entries delivered to this consumer but not started yet. XREADGROUP's COUNT
    // is per stream, so a multi-stream read can return more entries than free
    // slots; the excess waits here (at most one batch, bounded by stream count).
    this.backlog = [];
    this.abortController = new AbortController();
    this.stopSignal = new Promise((resolve) => {
      this.signalStop = resolve;
    });
  }

  /** Registers this process in `workers`; the row ID is the lease owner and consumer name. */
  async register() {
    const row = await this.workers.register({
      name: this.config.name ?? `worker-${os.hostname()}-${process.pid}`,
      hostname: os.hostname(),
      processId: process.pid,
      concurrency: this.config.concurrency,
      queues: this.config.queueIds ?? ['*'],
    });
    this.workerId = row.id;
    this.consumerName = `worker:${row.id}`;
    this.logger = this.baseLogger.child({ workerId: row.id });
    return row.id;
  }

  /** Resolves which streams to read and ensures the consumer group exists on each. */
  async refreshQueues() {
    const queueIds = this.config.queueIds ?? (await this.workers.listConsumableQueueIds());
    const keys = queueIds.map(jobStreamKey);
    for (const key of keys) {
      if (!this.streamKeys.includes(key)) {
        await ensureConsumerGroup(this.commands, key, this.config.group);
      }
    }
    if (!isDeepStrictEqual(keys, this.streamKeys)) {
      this.logger.info({ queues: queueIds.length }, 'Consuming queues updated');
    }
    this.streamKeys = keys;
    this.queuesRefreshedAt = Date.now();
  }

  // ---------------------------------------------------------------------------
  // Single-entry processing
  // ---------------------------------------------------------------------------

  /**
   * Handles one stream entry end to end. Never throws. Returns
   * `{ outcome, acked }` for logging and tests.
   */
  async processEntry(streamKey, entryId, fields) {
    const entry = fromStreamFields(fields);
    const log = this.logger.child({ entryId, jobId: entry.jobId, eventId: entry.eventId });

    if (!entry.jobId || !entry.queueId) {
      log.warn({ fields }, 'Malformed stream entry; acknowledging and discarding');
      return this.finish(streamKey, entryId, 'discarded:malformed', log);
    }

    // 1. Claim. A database error means we don't know the job's state: leave the
    //    entry pending so it is redelivered, and never run the handler.
    let claim;
    try {
      claim = await this.repository.claim({
        jobId: entry.jobId,
        queueId: entry.queueId,
        workerId: this.workerId,
        leaseMs: this.config.leaseMs,
      });
    } catch (err) {
      log.error({ err }, 'Claim failed with a database error; leaving entry pending');
      return { outcome: 'pending:claim-error', acked: false };
    }

    if (!claim) {
      return this.handleUnclaimable(streamKey, entryId, entry, log);
    }

    // 2. Execute outside any transaction.
    const jobLog = log.child({ attempt: claim.attempt, leaseVersion: claim.leaseVersion });
    const execution = await this.execute(claim, jobLog);

    if (execution.abandoned) {
      // Shutdown grace expired mid-run. Don't record a misleading outcome: the
      // job stays ACTIVE and its lease expires for recovery (Sprint 4).
      jobLog.warn('Handler interrupted by shutdown; leaving job for lease recovery');
      return { outcome: 'pending:abandoned', acked: false };
    }

    // 3. Persist the outcome with the fencing token, then 4. acknowledge.
    try {
      const { outcome, applied } = execution.ok
        ? { outcome: 'completed', applied: await this.repository.complete(claim, { result: execution.result }) }
        : await this.persistFailure(claim, execution.error);

      if (!applied) {
        jobLog.warn('Outcome rejected: lease was taken over; another owner is responsible for this job');
        return this.finish(streamKey, entryId, 'fenced', jobLog);
      }
      jobLog.info({ outcome, durationMs: execution.durationMs }, 'Job attempt finished');
      return this.finish(streamKey, entryId, outcome, jobLog);
    } catch (err) {
      jobLog.error({ err }, 'Persisting outcome failed; entry left pending, job stays ACTIVE until lease recovery');
      return { outcome: 'pending:persist-error', acked: false };
    }
  }

  /** Decides what to do with an entry whose job could not be claimed. */
  async handleUnclaimable(streamKey, entryId, entry, log) {
    let state;
    try {
      state = await this.repository.findState({ jobId: entry.jobId });
    } catch (err) {
      log.error({ err }, 'Could not inspect unclaimable job; leaving entry pending');
      return { outcome: 'pending:inspect-error', acked: false };
    }

    if (!state || state.queueId !== entry.queueId) {
      log.warn('Entry refers to a missing job or the wrong queue; discarding');
      return this.finish(streamKey, entryId, 'discarded:unknown-job', log);
    }
    if (TERMINAL.has(state.status)) {
      log.debug({ status: state.status }, 'Duplicate entry for a finished job; discarding');
      return this.finish(streamKey, entryId, 'discarded:terminal', log);
    }
    if (state.status === 'ACTIVE' || state.status === 'SCHEDULED' || state.status === 'RETRYING') {
      // Event policy: every transition into WAITING emits a fresh job.ready
      // event. An ACTIVE job is owned by someone else; SCHEDULED/RETRYING jobs
      // will get a new event when released. This entry is redundant either way.
      log.debug({ status: state.status }, 'Job not claimable now; a new event will follow if needed');
      return this.finish(streamKey, entryId, `discarded:${state.status.toLowerCase()}`, log);
    }
    // WAITING but not claimed: state changed between claim and inspection.
    // Keep the entry so it is retried rather than risk losing the job.
    log.warn({ status: state.status }, 'Job still WAITING after a failed claim; leaving entry pending');
    return { outcome: 'pending:race', acked: false };
  }

  async execute(claim, log) {
    const handler = this.registry.get(claim.name);
    const started = Date.now();

    if (!handler) {
      const error = new Error(`No handler registered for job name "${claim.name}"`);
      error.code = 'HANDLER_NOT_FOUND';
      error.retryable = false;
      return { ok: false, error, durationMs: 0 };
    }

    let value;
    try {
      value = await handler({
        job: {
          id: claim.jobId,
          queueId: claim.queueId,
          name: claim.name,
          payload: claim.payload,
          attempt: claim.attempt,
          maxAttempts: claim.maxAttempts,
        },
        signal: this.abortController.signal,
        logger: log,
      });
    } catch (err) {
      if (this.abortController.signal.aborted) {
        return { abandoned: true };
      }
      const error = err instanceof Error ? err : new Error(String(err));
      return { ok: false, error, durationMs: Date.now() - started };
    }

    // Normalize to JSON now so an unserializable result fails this attempt
    // instead of failing the database write.
    try {
      const result = value === undefined ? null : JSON.parse(JSON.stringify(value));
      return { ok: true, result, durationMs: Date.now() - started };
    } catch (err) {
      const error = new Error(`Handler result is not JSON-serializable: ${err.message}`);
      error.code = 'RESULT_NOT_SERIALIZABLE';
      error.retryable = false;
      return { ok: false, error, durationMs: Date.now() - started };
    }
  }

  /** Applies the retry policy: RETRYING with backoff, or FAILED / DEAD. */
  async persistFailure(claim, err) {
    let nextStatus = 'RETRYING';
    if (!isRetryable(err)) nextStatus = 'FAILED';
    else if (claim.attempt >= claim.maxAttempts) nextStatus = 'DEAD';

    const applied = await this.repository.fail(claim, {
      nextStatus,
      retryDelayMs:
        nextStatus === 'RETRYING'
          ? retryDelayMs(claim.attempt, { baseMs: this.config.retryBaseMs, maxMs: this.config.retryMaxMs })
          : null,
      error: { code: errorCode(err), message: err.message || String(err), stack: err.stack },
    });
    return { outcome: nextStatus.toLowerCase(), applied };
  }

  /** XACK after the durable state is committed. An ack failure only causes a harmless redelivery. */
  async finish(streamKey, entryId, outcome, log) {
    try {
      await this.commands.xack(streamKey, this.config.group, entryId);
      return { outcome, acked: true };
    } catch (err) {
      log.warn({ err, outcome }, 'XACK failed; entry will be redelivered and recognized as a duplicate');
      return { outcome, acked: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Consume loop and lifecycle
  // ---------------------------------------------------------------------------

  startEntry({ streamKey, entryId, fields }) {
    const task = this.processEntry(streamKey, entryId, fields).finally(() => {
      this.inflight.delete(task);
    });
    this.inflight.add(task);
  }

  /** Runs already-delivered backlog entries, respecting the concurrency limit. */
  async drainBacklog() {
    while (this.backlog.length > 0 && !this.abortController.signal.aborted) {
      if (this.inflight.size >= this.config.concurrency) {
        await Promise.race(this.inflight);
      } else {
        this.startEntry(this.backlog.shift());
      }
    }
  }

  async start() {
    if (this.running) return;
    if (!this.workerId) await this.register();
    this.running = true;
    this.logger.info(
      { concurrency: this.config.concurrency, handlers: this.registry.names() },
      'Worker started'
    );
    this.loopPromise = this.loop();
  }

  async loop() {
    let consecutiveErrors = 0;
    while (this.running) {
      try {
        if (this.inflight.size >= this.config.concurrency) {
          // Backpressure: read only when a slot is free (or stop is requested).
          await Promise.race([...this.inflight, this.stopSignal]);
          continue;
        }
        if (this.backlog.length > 0) {
          this.startEntry(this.backlog.shift());
          continue;
        }
        if (!isRedisReady(this.reader) || !isRedisReady(this.commands)) {
          // Startup or outage: wait quietly instead of failing commands.
          if (!this.waitingForRedis) {
            this.waitingForRedis = true;
            this.logger.warn('Redis not ready; waiting before reading jobs');
          }
          await Promise.race([delay(200), this.stopSignal]);
          continue;
        }
        if (this.waitingForRedis) {
          this.waitingForRedis = false;
          this.logger.info('Redis ready; reading jobs');
        }
        if (Date.now() - this.queuesRefreshedAt >= this.config.queueRefreshMs) {
          await this.refreshQueues();
        }
        if (this.streamKeys.length === 0) {
          await Promise.race([delay(Math.min(this.config.queueRefreshMs, 1000)), this.stopSignal]);
          continue;
        }

        const free = this.config.concurrency - this.inflight.size;
        const perStream = Math.max(1, Math.ceil(free / this.streamKeys.length));
        const response = await this.reader.xreadgroup(
          'GROUP', this.config.group, this.consumerName,
          'COUNT', perStream,
          'BLOCK', this.config.blockMs,
          'STREAMS', ...this.streamKeys, ...this.streamKeys.map(() => '>')
        );
        consecutiveErrors = 0;

        for (const [streamKey, entries] of response ?? []) {
          for (const [entryId, fields] of entries) {
            this.backlog.push({ streamKey, entryId, fields });
          }
        }
      } catch (err) {
        if (!this.running) break; // reader disconnected by stop()
        if (String(err.message).includes('NOGROUP')) {
          this.queuesRefreshedAt = 0; // stream or group was deleted; recreate on next pass
          this.streamKeys = [];
        }
        consecutiveErrors += 1;
        const wait = retryDelayMs(consecutiveErrors, { baseMs: 200, maxMs: 5000 });
        this.logger.error({ err, retryInMs: wait }, 'Worker read loop error');
        await Promise.race([delay(wait), this.stopSignal]);
      }
    }
  }

  /**
   * Graceful shutdown: stop reading, let in-flight jobs finish within the grace
   * period, then abort the rest (they are left ACTIVE for lease recovery).
   */
  async stop() {
    if (!this.running) return;
    this.running = false;
    this.signalStop();
    this.logger.info({ inflight: this.inflight.size }, 'Worker draining');
    await this.workers.setStatus(this.workerId, 'DRAINING').catch((err) =>
      this.logger.warn({ err }, 'Could not mark worker DRAINING')
    );

    // Interrupt a blocked XREADGROUP; the loop sees running=false and exits.
    this.reader.disconnect();
    await this.loopPromise;

    // Entries already delivered to this consumer are finished too (no new reads).
    const drained = await Promise.race([
      this.drainBacklog()
        .then(() => Promise.allSettled([...this.inflight]))
        .then(() => true),
      delay(this.config.shutdownGraceMs).then(() => false),
    ]);
    if (!drained) {
      this.logger.warn(
        { inflight: this.inflight.size, undelivered: this.backlog.length },
        'Shutdown grace expired; aborting in-flight handlers. Unstarted entries stay pending for redelivery'
      );
      this.abortController.abort();
      await Promise.allSettled([...this.inflight]);
    }

    await this.workers.setStatus(this.workerId, 'STOPPED').catch((err) =>
      this.logger.warn({ err }, 'Could not mark worker STOPPED')
    );
    this.logger.info('Worker stopped');
  }
}
