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

const entryKey = (streamKey, entryId) => `${streamKey}|${entryId}`;

/**
 * Worker runtime. Consumes job.ready entries from per-queue Redis streams via a
 * consumer group, and executes jobs it has atomically claimed in PostgreSQL.
 *
 * Per entry:  claim in PG -> run handler (outside any transaction, lease renewed
 *             in the background) -> persist outcome fenced by lease_version
 *             -> commit -> XACK.
 *
 * The claim also enforces queue controls under a lock on the queue row:
 * paused/archived queues dispatch nothing (the entry is acknowledged; resume
 * re-announces), and a queue at `queues.concurrency` defers the entry: it
 * stays pending and the claim is retried with backoff.
 *
 * Cancellation is cooperative: running jobs are polled for cancel requests and
 * their handler's signal is aborted; the job is recorded CANCELLED only after
 * the handler has returned.
 *
 * A Redis delivery never grants execution rights; only the PG claim does.
 * XACK happens only after the durable outcome commits, so a crash at any point
 * leaves the entry pending. Pending entries idle for too long are taken over
 * with XAUTOCLAIM by any worker, and expired leases are recovered by the
 * recovery process.
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
    this.commands = commands; // XACK, XGROUP, XAUTOCLAIM; never blocked by the reader
    this.registry = registry;
    this.baseLogger = logger;
    this.logger = logger;
    this.config = {
      leaseRenewMs: Math.max(100, Math.floor(config.leaseMs / 3)),
      heartbeatMs: 5000,
      pendingIdleMs: 60_000,
      pendingCheckMs: 15_000,
      cancelCheckMs: 1000,
      capacityRetryBaseMs: 200,
      capacityRetryMaxMs: 2000,
      ...config,
    };
    if (this.config.leaseRenewMs >= this.config.leaseMs) {
      throw new Error('leaseRenewMs must be shorter than leaseMs');
    }
    this.repository = repository;
    this.workers = workers;

    this.workerId = null;
    this.consumerName = null;
    this.status = 'STARTING';
    this.streamKeys = [];
    this.queuesRefreshedAt = 0;
    this.pendingCheckedAt = 0;
    this.pendingCursors = new Map(); // XAUTOCLAIM cursor per stream
    this.running = false;
    this.waitingForRedis = false;
    this.loopPromise = null;
    this.heartbeatTimer = null;
    this.heartbeatPromise = null;
    this.heartbeatFailing = false;
    this.inflight = new Set();
    // Entries delivered to this consumer but not started yet. XREADGROUP's COUNT
    // is per stream, so a multi-stream read can return more entries than free
    // slots; the excess waits here (at most one batch, bounded by stream count).
    this.backlog = [];
    // Entries in the backlog, in flight or deferred, so XAUTOCLAIM doesn't hand us our own work twice.
    this.activeEntries = new Set();
    // Entries whose claim hit the queue's concurrency limit, keyed by entryKey:
    // { item, retryAt }. They stay pending in Redis (so a crash loses nothing),
    // and their streams are not read until the retry, so a full queue costs
    // one claim attempt per backoff interval instead of a stream of rejections.
    this.deferred = new Map();
    // Jobs executing now, by job ID: { leaseVersion, cancel }. Used by the cancel poll.
    this.runningJobs = new Map();
    this.cancelTimer = null;
    this.cancelCheckPromise = null;
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
    this.status = 'RUNNING';
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
    const claimStartedAt = Date.now();
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
    if (claim.rejected === 'QUEUE_NOT_ACTIVE') {
      // Paused or archived: nothing is dispatched. Resuming the queue emits a
      // fresh job.ready for every WAITING job, so this entry can go.
      log.debug({ queueStatus: claim.queueStatus }, 'Queue is not active; entry discarded until resume');
      return this.finish(streamKey, entryId, 'discarded:queue-not-active', log);
    }
    if (claim.rejected === 'QUEUE_AT_CAPACITY') {
      // Keep the entry pending (no ack) and retry the claim later; see deferEntry().
      log.debug({ active: claim.active, concurrency: claim.concurrency }, 'Queue at its concurrency limit; deferring');
      return { outcome: 'deferred:queue-at-capacity', acked: false, deferred: true };
    }

    // 2. Execute outside any transaction, renewing the lease while it runs.
    const jobLog = log.child({ attempt: claim.attempt, leaseVersion: claim.leaseVersion });
    const lease = this.holdLease(claim, jobLog, claimStartedAt);
    let execution;
    try {
      execution = await this.execute(claim, jobLog, lease.signal, lease.abortReason);
    } finally {
      lease.release();
    }

    if (execution.abandoned === 'lease-lost') {
      // Someone else owns the job now (recovery or a new claim), and they
      // emit a new event if it needs to run again. This entry is redundant.
      jobLog.warn('Handler aborted after the lease was lost; outcome discarded');
      return this.finish(streamKey, entryId, 'lease-lost', jobLog);
    }
    if (execution.abandoned === 'cancelled') {
      return this.recordCancelled(streamKey, entryId, claim, jobLog);
    }
    if (execution.abandoned === 'shutdown') {
      return this.releaseInterrupted(streamKey, entryId, claim, jobLog);
    }

    // 3. Persist the outcome with the fencing token, then 4. acknowledge.
    //    A handler that ignored a cancel request and succeeded is recorded as
    //    COMPLETED: that is what happened. A failure after a cancel request
    //    becomes CANCELLED (never retried); the repository decides that.
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
      // event. An ACTIVE job is owned by someone else (and recovered via its
      // lease if they die); SCHEDULED/RETRYING jobs get a new event when
      // released. This entry is redundant either way.
      log.debug({ status: state.status }, 'Job not claimable now; a new event will follow if needed');
      return this.finish(streamKey, entryId, `discarded:${state.status.toLowerCase()}`, log);
    }
    // WAITING but not claimed: state changed between claim and inspection.
    // Keep the entry so it is retried rather than risk losing the job.
    log.warn({ status: state.status }, 'Job still WAITING after a failed claim; leaving entry pending');
    return { outcome: 'pending:race', acked: false };
  }

  /**
   * Renews the job lease every `leaseRenewMs` while the handler runs. The
   * returned signal aborts on shutdown, on a cancel request, or when the lease
   * is lost: either another owner took the job over, or renewal kept failing
   * until the lease had certainly expired (recovery may hand the job out again
   * at any moment). `abortReason()` says which, lease loss taking precedence
   * because then this worker may not write anything.
   */
  holdLease(claim, log, claimStartedAt) {
    const controller = new AbortController();
    const cancelController = new AbortController();
    let lastRenewedAt = claimStartedAt; // conservative: the lease started no later than this
    let renewing = false;
    let released = false;

    const lose = (reason) => {
      if (controller.signal.aborted || released) return;
      log.warn({ reason }, 'Job lease lost; aborting handler');
      controller.abort(new Error(`Job lease lost (${reason})`));
    };

    this.runningJobs.set(claim.jobId, {
      leaseVersion: claim.leaseVersion,
      cancel: () => {
        if (cancelController.signal.aborted || released) return;
        log.info('Cancel requested; aborting handler');
        const err = new Error('Job cancelled');
        err.code = 'CANCELLED';
        cancelController.abort(err);
      },
    });

    const timer = setInterval(async () => {
      if (renewing || released || controller.signal.aborted) return;
      renewing = true;
      const attemptedAt = Date.now();
      try {
        const renewed = await this.repository.renewLease(claim, { leaseMs: this.config.leaseMs });
        if (renewed) lastRenewedAt = attemptedAt;
        else lose('taken-over');
      } catch (err) {
        log.warn({ err }, 'Lease renewal failed');
        if (Date.now() - lastRenewedAt >= this.config.leaseMs) lose('expired');
      } finally {
        renewing = false;
      }
    }, this.config.leaseRenewMs);

    return {
      signal: AbortSignal.any([this.abortController.signal, controller.signal, cancelController.signal]),
      abortReason: () => {
        if (controller.signal.aborted) return 'lease-lost';
        if (cancelController.signal.aborted) return 'cancelled';
        return 'shutdown';
      },
      release: () => {
        released = true;
        clearInterval(timer);
        this.runningJobs.delete(claim.jobId);
      },
    };
  }

  /**
   * Polls for cancel requests on the jobs this worker is running and aborts
   * those handlers. The job stays ACTIVE until the handler has returned and
   * the outcome is written (see recordCancelled), so a running job is never
   * reported as cancelled.
   */
  async checkCancellations() {
    if (this.cancelCheckPromise || this.runningJobs.size === 0) return this.cancelCheckPromise;
    this.cancelCheckPromise = (async () => {
      try {
        const requested = await this.repository.findCancelRequested({ workerId: this.workerId });
        for (const { jobId, leaseVersion } of requested) {
          const running = this.runningJobs.get(jobId);
          if (running && running.leaseVersion === leaseVersion) running.cancel();
        }
      } catch (err) {
        this.logger.warn({ err }, 'Cancel check failed; will retry');
      } finally {
        this.cancelCheckPromise = null;
      }
    })();
    return this.cancelCheckPromise;
  }

  async execute(claim, log, signal = this.abortController.signal, abortReason = null) {
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
        signal,
        logger: log,
      });
    } catch (err) {
      if (signal.aborted) {
        return {
          abandoned: abortReason ? abortReason() : this.abortController.signal.aborted ? 'shutdown' : 'lease-lost',
        };
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
  async persistFailure(claim, err, { attemptStatus = 'FAILED' } = {}) {
    let nextStatus = 'RETRYING';
    if (!isRetryable(err)) nextStatus = 'FAILED';
    else if (claim.attempt >= claim.maxAttempts) nextStatus = 'DEAD';

    const applied = await this.repository.fail(claim, {
      nextStatus,
      attemptStatus,
      retryDelayMs:
        nextStatus === 'RETRYING'
          ? retryDelayMs(claim.attempt, { baseMs: this.config.retryBaseMs, maxMs: this.config.retryMaxMs })
          : null,
      error: { code: errorCode(err), message: err.message || String(err), stack: err.stack },
    });
    // The repository returns the status actually written (CANCELLED wins if a
    // cancel was requested), or false when fenced out.
    const written = typeof applied === 'string' ? applied : nextStatus;
    return { outcome: written.toLowerCase(), applied: Boolean(applied) };
  }

  /**
   * The handler stopped after a cancel request and has returned: record the
   * job CANCELLED and the attempt CANCELLED, fenced like any outcome. If the
   * write fails the job stays ACTIVE with cancel_requested_at set, and lease
   * recovery makes it CANCELLED once the lease expires.
   */
  async recordCancelled(streamKey, entryId, claim, log) {
    try {
      const applied = await this.repository.fail(claim, {
        nextStatus: 'CANCELLED',
        attemptStatus: 'CANCELLED',
        retryDelayMs: null,
        error: { code: 'CANCELLED', message: 'Job was cancelled while running' },
      });
      if (!applied) {
        return this.finish(streamKey, entryId, 'fenced', log);
      }
      log.info('Handler stopped after a cancel request; job CANCELLED');
      return this.finish(streamKey, entryId, 'cancelled', log);
    } catch (err) {
      log.error({ err }, 'Could not record cancellation; lease recovery will finish it');
      return { outcome: 'pending:cancel-error', acked: false };
    }
  }

  /**
   * The handler was aborted by shutdown and has returned, so nothing is running
   * the job any more: hand it back now (attempt INTERRUPTED, job RETRYING or
   * DEAD) instead of making it wait for the lease to expire. If that write
   * fails, the entry stays pending and lease recovery handles the job.
   */
  async releaseInterrupted(streamKey, entryId, claim, log) {
    const err = new Error('Worker shut down before the attempt finished');
    err.code = 'WORKER_SHUTDOWN';
    try {
      const { outcome, applied } = await this.persistFailure(claim, err, { attemptStatus: 'INTERRUPTED' });
      if (!applied) {
        return this.finish(streamKey, entryId, 'fenced', log);
      }
      log.warn({ outcome }, 'Handler interrupted by shutdown; attempt recorded as INTERRUPTED');
      return this.finish(streamKey, entryId, `interrupted:${outcome}`, log);
    } catch (e) {
      log.error({ err: e }, 'Could not release interrupted job; it will be recovered when its lease expires');
      return { outcome: 'pending:abandoned', acked: false };
    }
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
  // Stale pending entries (XAUTOCLAIM)
  // ---------------------------------------------------------------------------

  /**
   * Takes over entries that have been pending longer than `pendingIdleMs` in
   * any consumer of the group: a worker that crashed after reading an entry,
   * or an entry left pending after a database error. Processing them is safe:
   * the PG claim decides whether anything runs. Returns the number queued.
   */
  async claimStalePending(limit) {
    this.pendingCheckedAt = Date.now();
    let queued = 0;
    for (const streamKey of this.streamKeys) {
      if (queued >= limit) break;
      const cursor = this.pendingCursors.get(streamKey) ?? '0-0';
      const [next, entries] = await this.commands.xautoclaim(
        streamKey, this.config.group, this.consumerName,
        this.config.pendingIdleMs, cursor, 'COUNT', limit - queued
      );
      this.pendingCursors.set(streamKey, next);

      for (const [entryId, fields] of entries) {
        if (this.activeEntries.has(entryKey(streamKey, entryId))) continue; // ours, already in progress
        if (!fields) {
          // Redis 6.2 returns deleted entries as nil; nothing to process.
          await this.commands.xack(streamKey, this.config.group, entryId);
          continue;
        }
        this.enqueue({ streamKey, entryId, fields });
        queued += 1;
      }
    }
    if (queued > 0) {
      this.logger.info({ entries: queued }, 'Took over stale pending stream entries');
    }
    return queued;
  }

  // ---------------------------------------------------------------------------
  // Consume loop and lifecycle
  // ---------------------------------------------------------------------------

  enqueue(item) {
    this.activeEntries.add(entryKey(item.streamKey, item.entryId));
    this.backlog.push(item);
  }

  startEntry(item) {
    const { streamKey, entryId, fields } = item;
    const task = this.processEntry(streamKey, entryId, fields)
      .then((result) => {
        if (result.deferred) this.deferEntry(item);
        else this.activeEntries.delete(entryKey(streamKey, entryId));
        return result;
      })
      .finally(() => this.inflight.delete(task));
    this.inflight.add(task);
  }

  /**
   * Holds an entry whose queue was at its concurrency limit and schedules a
   * claim retry with backoff. Its stream is not read meanwhile (see
   * readableStreams), so each worker holds at most a few entries per full queue.
   * The entry stays pending in Redis: if this worker dies, XAUTOCLAIM hands it on.
   */
  deferEntry(item) {
    const key = entryKey(item.streamKey, item.entryId);
    if (!this.running) {
      this.activeEntries.delete(key); // shutting down: leave it pending for another worker
      return;
    }
    item.capacityRetries = (item.capacityRetries ?? 0) + 1;
    const wait = retryDelayMs(item.capacityRetries, {
      baseMs: this.config.capacityRetryBaseMs,
      maxMs: this.config.capacityRetryMaxMs,
    });
    this.deferred.set(key, { item, retryAt: Date.now() + wait });
  }

  /** Moves deferred entries whose retry time has come back into the backlog. */
  releaseDueDeferred(now = Date.now()) {
    for (const [key, { item, retryAt }] of this.deferred) {
      if (retryAt <= now) {
        this.deferred.delete(key);
        this.backlog.push(item);
      }
    }
  }

  nextDeferredRetryAt() {
    let next = Infinity;
    for (const { retryAt } of this.deferred.values()) next = Math.min(next, retryAt);
    return next;
  }

  /** Streams to read new entries from: all except those with a deferred entry. */
  readableStreams() {
    if (this.deferred.size === 0) return this.streamKeys;
    const held = new Set([...this.deferred.values()].map(({ item }) => item.streamKey));
    return this.streamKeys.filter((key) => !held.has(key));
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

  /** Records liveness. Failures are logged once per outage; leases keep jobs safe meanwhile. */
  async heartbeat() {
    if (this.heartbeatPromise) return this.heartbeatPromise;
    this.heartbeatPromise = (async () => {
      try {
        const alive = await this.workers.heartbeat(this.workerId, {
          status: this.status,
          activeJobs: this.inflight.size,
        });
        if (!alive) this.logger.warn('Heartbeat matched no live worker row');
        if (this.heartbeatFailing) this.logger.info('Heartbeat recovered');
        this.heartbeatFailing = false;
      } catch (err) {
        if (!this.heartbeatFailing) this.logger.warn({ err }, 'Heartbeat failed');
        this.heartbeatFailing = true;
      } finally {
        this.heartbeatPromise = null;
      }
    })();
    return this.heartbeatPromise;
  }

  async start() {
    if (this.running) return;
    if (!this.workerId) await this.register();
    this.running = true;
    this.status = 'RUNNING';
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.config.heartbeatMs);
    this.cancelTimer = setInterval(() => this.checkCancellations(), this.config.cancelCheckMs);
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
        if (this.deferred.size > 0) this.releaseDueDeferred();
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
        if (Date.now() - this.pendingCheckedAt >= this.config.pendingCheckMs) {
          if ((await this.claimStalePending(free)) > 0) continue;
        }

        // Streams with a deferred entry (queue at capacity) are not read until
        // its retry; don't block past that retry either.
        const readable = this.readableStreams();
        const untilRetry = this.deferred.size > 0 ? Math.max(10, this.nextDeferredRetryAt() - Date.now()) : Infinity;
        if (readable.length === 0) {
          await Promise.race([delay(Math.min(untilRetry, this.config.blockMs)), this.stopSignal]);
          continue;
        }

        const perStream = Math.max(1, Math.ceil(free / readable.length));
        const response = await this.reader.xreadgroup(
          'GROUP', this.config.group, this.consumerName,
          'COUNT', perStream,
          'BLOCK', Math.min(this.config.blockMs, untilRetry),
          'STREAMS', ...readable, ...readable.map(() => '>')
        );
        consecutiveErrors = 0;

        for (const [streamKey, entries] of response ?? []) {
          for (const [entryId, fields] of entries) {
            this.enqueue({ streamKey, entryId, fields });
          }
        }
      } catch (err) {
        if (!this.running) break; // reader disconnected by stop()
        if (String(err.message).includes('NOGROUP')) {
          this.queuesRefreshedAt = 0; // stream or group was deleted; recreate on next pass
          this.streamKeys = [];
          this.pendingCursors.clear();
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
   * period, then abort the rest. Aborted jobs are handed back immediately
   * (attempt INTERRUPTED -> RETRYING/DEAD); if that fails, lease recovery does it.
   * Heartbeats and lease renewal continue while draining.
   */
  async stop() {
    if (!this.running) return;
    this.running = false;
    this.status = 'DRAINING';
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

    if (this.deferred.size > 0) {
      // Never claimed, so nothing to hand back; they stay pending for XAUTOCLAIM.
      this.logger.info({ entries: this.deferred.size }, 'Leaving deferred entries pending for other workers');
      for (const key of this.deferred.keys()) this.activeEntries.delete(key);
      this.deferred.clear();
    }

    clearInterval(this.heartbeatTimer);
    clearInterval(this.cancelTimer);
    await Promise.all([this.heartbeatPromise, this.cancelCheckPromise]);
    this.status = 'STOPPED';
    await this.workers.setStatus(this.workerId, 'STOPPED').catch((err) =>
      this.logger.warn({ err }, 'Could not mark worker STOPPED')
    );
    this.logger.info('Worker stopped');
  }
}
