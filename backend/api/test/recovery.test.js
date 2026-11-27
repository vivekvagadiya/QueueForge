import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { getDatabase } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { closeRedis } from '../src/config/redis.js';
import { logger } from '../src/config/logger.js';
import { OutboxPublisher } from '../src/outbox/outboxPublisher.js';
import { RecoveryService } from '../src/recovery/recoveryService.js';
import { jobExecutionRepository } from '../src/repositories/jobExecution.repository.js';
import { recoveryRepository } from '../src/repositories/recovery.repository.js';
import { jobStreamKey } from '../src/streams/jobStream.js';
import { HandlerRegistry } from '../src/worker/handlerRegistry.js';
import { Worker } from '../src/worker/worker.js';
import {
  app,
  clearTestStreams,
  connectTestRedis,
  createQueue,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  teardownDatabase,
} from './helpers.js';

const GROUP = env.CONSUMER_GROUP;
const CONFIG = {
  group: GROUP,
  queueIds: null,
  queueRefreshMs: 50,
  concurrency: 5,
  blockMs: 100,
  leaseMs: 30_000,
  heartbeatMs: 5000,
  pendingIdleMs: 60_000,
  pendingCheckMs: 60_000,
  shutdownGraceMs: 5000,
  retryBaseMs: 1000,
  retryMaxMs: 60_000,
};
const RECOVERY_CONFIG = { intervalMs: 50, batchSize: 100, heartbeatTimeoutMs: 30_000, retryBaseMs: 1, retryMaxMs: 10 };

let redis;
let owner;
let queue;
let calls;
let readers;
let services;

const sql = async (query, bind = []) => (await getDatabase().query(query, { bind }))[0];

const testRegistry = () => {
  const registry = new HandlerRegistry();
  const flaky = new Set();
  registry
    .register('test.ok', async ({ job }) => {
      calls.push(job.id);
      return { ok: true, attempt: job.attempt };
    })
    .register('test.fail', async ({ job }) => {
      calls.push(job.id);
      throw new Error('boom');
    })
    .register('test.flaky', async ({ job }) => {
      calls.push(job.id);
      if (!flaky.has(job.id)) {
        flaky.add(job.id);
        throw new Error('transient');
      }
      return { ok: true, attempt: job.attempt };
    })
    .register('test.slow', async ({ job, signal }) => {
      calls.push(job.id);
      await delay(job.payload.ms ?? 100, undefined, { signal });
      return { slept: true };
    });
  return registry;
};

const makeWorker = async ({ config = {}, repository } = {}) => {
  const reader = await connectTestRedis();
  readers.push(reader);
  const worker = new Worker({
    reader,
    commands: redis,
    registry: testRegistry(),
    logger,
    config: { ...CONFIG, ...config },
    repository,
  });
  await worker.register();
  return worker;
};

const makeRecovery = (config = {}) => {
  const service = new RecoveryService({ logger, config: { ...RECOVERY_CONFIG, ...config } });
  services.push(service);
  return service;
};

const newPublisher = () =>
  new OutboxPublisher({
    redis,
    logger,
    config: { pollIntervalMs: 20, batchSize: 100, claimTimeoutMs: 30_000, baseMs: 1000, maxMs: 60_000 },
  });
const publishAll = () => newPublisher().runOnce();

const submit = async (body, queueId = queue.id) => {
  const res = await request(app)
    .post(`/api/v1/queues/${queueId}/jobs`)
    .set('Authorization', owner.auth)
    .send(body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};

/** Delivers new entries to a worker's consumer, as XREADGROUP in its loop would. */
const deliver = async (worker, count = 10) => {
  await worker.refreshQueues();
  const res = await redis.xreadgroup(
    'GROUP', GROUP, worker.consumerName, 'COUNT', count,
    'STREAMS', jobStreamKey(queue.id), '>'
  );
  return res ? res[0][1].map(([id, fields]) => ({ streamKey: res[0][0], id, fields })) : [];
};

const process1 = (worker, e) => worker.processEntry(e.streamKey, e.id, e.fields);

/** Runs everything a worker's XAUTOCLAIM pass queued. */
const processReclaimed = async (worker) => {
  await worker.refreshQueues();
  await worker.claimStalePending(10);
  const results = [];
  while (worker.backlog.length) {
    const item = worker.backlog.shift();
    results.push(await process1(worker, { streamKey: item.streamKey, id: item.entryId, fields: item.fields }));
    worker.activeEntries.delete(`${item.streamKey}|${item.entryId}`);
  }
  return results;
};

const pendingCount = async () => {
  try {
    return Number((await redis.xpending(jobStreamKey(queue.id), GROUP))[0]);
  } catch {
    return 0;
  }
};

const jobRow = async (id) =>
  (await sql(`SELECT status, result, last_error, locked_by, lease_version, attempts_made,
                     scheduled_at, completed_at FROM jobs WHERE id = $1`, [id]))[0];

const attemptRows = (id) =>
  sql(`SELECT attempt_number, worker_id, status, lease_version, error_code
       FROM job_attempts WHERE job_id = $1 ORDER BY attempt_number`, [id]);

const expireLease = (jobId) =>
  sql(`UPDATE jobs SET lock_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [jobId]);

const outboxCount = async (jobId) =>
  Number((await sql(`SELECT COUNT(*)::int AS n FROM outbox_events WHERE aggregate_id = $1`, [jobId]))[0].n);

const waitFor = async (check, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'condition not met in time');
    await delay(25);
  }
};

/** A worker that "crashed": it was registered and read entries, then vanished. */
const crashedWorker = () => makeWorker();

before(async () => {
  await setupDatabase();
  redis = await connectTestRedis();
});
after(async () => {
  await closeRedis(redis);
  await teardownDatabase();
});
beforeEach(async () => {
  await resetDatabase();
  await clearTestStreams(redis);
  calls = [];
  readers = [];
  services = [];
  owner = await createUser();
  // Concurrency above the number of jobs any test claims at once; limits are tested in controls.test.js.
  queue = await createQueue(owner.auth, { name: 'recovery', concurrency: 50 });
});
afterEach(async () => {
  await Promise.all(services.map((s) => s.stop()));
  await Promise.all(readers.map((r) => closeRedis(r)));
});

describe('lease renewal', () => {
  test('a handler running longer than the lease keeps the job while recovery runs', async () => {
    const job = await submit({ name: 'test.slow', payload: { ms: 1800 } });
    await publishAll();
    const worker = await makeWorker({ config: { leaseMs: 1000, leaseRenewMs: 150 } });
    makeRecovery().start();

    const [entry] = await deliver(worker);
    assert.deepEqual(await process1(worker, entry), { outcome: 'completed', acked: true });

    assert.equal((await jobRow(job.id)).status, 'COMPLETED');
    const attempts = await attemptRows(job.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, 'SUCCEEDED');
  });

  test('losing the lease to another owner aborts the handler and discards its outcome', async () => {
    const job = await submit({ name: 'test.slow', payload: { ms: 10_000 } });
    await publishAll();
    const worker = await makeWorker({ config: { leaseMs: 5000, leaseRenewMs: 100 } });
    const [entry] = await deliver(worker);

    const started = Date.now();
    const running = process1(worker, entry);
    await waitFor(async () => (await jobRow(job.id)).status === 'ACTIVE');
    // Simulate recovery + a new claim by someone else.
    await sql(`UPDATE jobs SET lease_version = lease_version + 1, locked_by = gen_random_uuid() WHERE id = $1`, [job.id]);

    assert.deepEqual(await running, { outcome: 'lease-lost', acked: true });
    assert.ok(Date.now() - started < 3000, 'handler aborted promptly');
    const row = await jobRow(job.id);
    assert.equal(row.status, 'ACTIVE', 'the new owner keeps the job');
    assert.notEqual(row.locked_by, worker.workerId);
  });

  test('if renewal keeps failing until the lease has expired, the handler is aborted', async () => {
    const job = await submit({ name: 'test.slow', payload: { ms: 10_000 } });
    await publishAll();
    const worker = await makeWorker({
      config: { leaseMs: 1000, leaseRenewMs: 100 },
      repository: {
        ...jobExecutionRepository,
        renewLease: async () => {
          throw new Error('connection terminated');
        },
      },
    });
    const [entry] = await deliver(worker);

    const started = Date.now();
    assert.deepEqual(await process1(worker, entry), { outcome: 'lease-lost', acked: true });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 900 && elapsed < 3000, `aborted after the lease expired (${elapsed}ms)`);

    // Recovery then hands the job out again.
    await recoveryRepository.recoverExpiredLeases({ limit: 10, retryBaseMs: 1, retryMaxMs: 1 });
    assert.equal((await jobRow(job.id)).status, 'RETRYING');
  });

  test('renewal is fenced on the lease version', async () => {
    const job = await submit({ name: 'test.ok' });
    const worker = await makeWorker();
    const claim = await jobExecutionRepository.claim({ jobId: job.id, queueId: queue.id, workerId: worker.workerId, leaseMs: 1000 });
    assert.equal(await jobExecutionRepository.renewLease({ ...claim, leaseVersion: '0' }, { leaseMs: 1000 }), false);
    assert.equal(await jobExecutionRepository.renewLease(claim, { leaseMs: 1000 }), true);
  });
});

describe('expired lease recovery', () => {
  test('crash during execution: attempt INTERRUPTED, job retried with a new event, stale worker fenced out', async () => {
    const job = await submit({ name: 'test.ok', maxAttempts: 3 });
    await publishAll();

    // Worker A reads the entry, claims the job, then dies mid-handler.
    const dead = await crashedWorker();
    const [deadEntry] = await deliver(dead);
    const staleClaim = await jobExecutionRepository.claim({
      jobId: job.id, queueId: queue.id, workerId: dead.workerId, leaseMs: 30_000,
    });
    await expireLease(job.id);

    const recovery = makeRecovery();
    const first = await recovery.runOnce();
    assert.equal(first.recovered, 1);
    await delay(20);
    await recovery.runOnce(); // releases the (tiny) backoff if the first pass was too early

    let row = await jobRow(job.id);
    assert.equal(row.status, 'WAITING');
    assert.equal(row.locked_by, null);
    assert.equal(row.last_error.code, 'LEASE_EXPIRED');
    assert.equal(await outboxCount(job.id), 2, 'submit event + retry-release event');
    assert.deepEqual((await attemptRows(job.id)).map((a) => [a.status, a.error_code]), [['INTERRUPTED', 'LEASE_EXPIRED']]);

    // Worker B gets the new event and completes attempt 2.
    await publishAll();
    const live = await makeWorker({ config: { pendingIdleMs: 0 } });
    const [freshEntry] = await deliver(live);
    assert.equal(freshEntry.fields[freshEntry.fields.indexOf('jobId') + 1], job.id);
    assert.deepEqual(await process1(live, freshEntry), { outcome: 'completed', acked: true });

    // The stale worker wakes up and tries to report: rejected.
    assert.equal(await jobExecutionRepository.complete(staleClaim, { result: { stale: true } }), false);
    assert.equal(await jobExecutionRepository.renewLease(staleClaim, { leaseMs: 1000 }), false);

    row = await jobRow(job.id);
    assert.equal(row.status, 'COMPLETED');
    assert.deepEqual(row.result, { ok: true, attempt: 2 });
    assert.deepEqual((await attemptRows(job.id)).map((a) => a.status), ['INTERRUPTED', 'SUCCEEDED']);

    // The dead consumer's entry is taken over and discarded without running anything.
    const reclaimed = await processReclaimed(live);
    assert.deepEqual(reclaimed, [{ outcome: 'discarded:terminal', acked: true }]);
    assert.ok(deadEntry);
    assert.deepEqual(calls, [job.id]);
    assert.equal(await pendingCount(), 0);
  });

  test('a lease that expires on the last allowed attempt makes the job DEAD', async () => {
    const job = await submit({ name: 'test.ok', maxAttempts: 1 });
    const worker = await makeWorker();
    await jobExecutionRepository.claim({ jobId: job.id, queueId: queue.id, workerId: worker.workerId, leaseMs: 30_000 });
    await expireLease(job.id);

    const result = await makeRecovery().runOnce();
    assert.deepEqual(result, { recovered: 1, scheduled: 0, released: 0, unhealthyWorkers: 0 });
    const row = await jobRow(job.id);
    assert.equal(row.status, 'DEAD');
    assert.ok(row.completed_at);
    assert.equal((await attemptRows(job.id))[0].status, 'INTERRUPTED');
    assert.equal(await outboxCount(job.id), 1, 'no new event for a terminal job');
  });

  test('unexpired and renewed leases are left alone', async () => {
    const job = await submit({ name: 'test.ok' });
    const worker = await makeWorker();
    const claim = await jobExecutionRepository.claim({ jobId: job.id, queueId: queue.id, workerId: worker.workerId, leaseMs: 30_000 });
    assert.equal((await makeRecovery().runOnce()).recovered, 0);

    await expireLease(job.id);
    assert.equal(await jobExecutionRepository.renewLease(claim, { leaseMs: 30_000 }), true);
    assert.equal((await makeRecovery().runOnce()).recovered, 0);
    assert.equal((await jobRow(job.id)).status, 'ACTIVE');
  });

  test('recovery racing a worker finishing: exactly one of them wins, with consistent history', async () => {
    const outcomes = new Set();
    for (let round = 0; round < 15; round += 1) {
      const job = await submit({ name: 'test.ok', maxAttempts: 3 });
      const worker = await makeWorker();
      const claim = await jobExecutionRepository.claim({ jobId: job.id, queueId: queue.id, workerId: worker.workerId, leaseMs: 30_000 });
      await expireLease(job.id);

      const [completed, recovered] = await Promise.all([
        jobExecutionRepository.complete(claim, { result: { round } }),
        recoveryRepository.recoverExpiredLeases({ limit: 10, retryBaseMs: 1000, retryMaxMs: 1000 }),
      ]);
      const row = await jobRow(job.id);
      const [attempt] = await attemptRows(job.id);
      if (completed) {
        assert.equal(recovered.length, 0, `round ${round}`);
        assert.equal(row.status, 'COMPLETED');
        assert.equal(attempt.status, 'SUCCEEDED');
      } else {
        assert.equal(recovered.length, 1, `round ${round}`);
        assert.equal(row.status, 'RETRYING');
        assert.equal(attempt.status, 'INTERRUPTED');
      }
      outcomes.add(completed ? 'worker' : 'recovery');
    }
    assert.ok(outcomes.size >= 1);
  });

  test('concurrent recovery instances never recover or release a job twice', async () => {
    const worker = await makeWorker();
    const jobs = [];
    for (let i = 0; i < 20; i += 1) {
      const job = await submit({ name: 'test.ok', maxAttempts: 3 });
      await jobExecutionRepository.claim({ jobId: job.id, queueId: queue.id, workerId: worker.workerId, leaseMs: 30_000 });
      jobs.push(job);
    }
    await sql(`UPDATE jobs SET lock_expires_at = NOW() - INTERVAL '1 second'`);

    const recovered = await Promise.all([1, 2, 3].map(() =>
      recoveryRepository.recoverExpiredLeases({ limit: 100, retryBaseMs: 1, retryMaxMs: 1 })));
    assert.equal(recovered.flat().length, 20);
    assert.equal(new Set(recovered.flat().map((r) => r.id)).size, 20);

    await delay(20);
    const released = await Promise.all([1, 2, 3].map(() => recoveryRepository.releaseDueRetries({ limit: 100 })));
    assert.equal(released.flat().length, 20);
    assert.equal(new Set(released.flat()).size, 20);
    for (const job of jobs) {
      assert.equal(await outboxCount(job.id), 2, 'exactly one release event per job');
      assert.equal((await attemptRows(job.id)).length, 1);
    }
  });

  test('retries are released only once they are due', async () => {
    const job = await submit({ name: 'test.fail', maxAttempts: 3 });
    await publishAll();
    const worker = await makeWorker({ config: { retryBaseMs: 60_000, retryMaxMs: 60_000 } });
    const [entry] = await deliver(worker);
    assert.equal((await process1(worker, entry)).outcome, 'retrying');

    assert.deepEqual(await recoveryRepository.releaseDueRetries({ limit: 10 }), []);
    await sql(`UPDATE jobs SET scheduled_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [job.id]);
    assert.deepEqual(await recoveryRepository.releaseDueRetries({ limit: 10 }), [job.id]);
    assert.equal((await jobRow(job.id)).status, 'WAITING');
    assert.equal(await outboxCount(job.id), 2);
  });
});

describe('stale pending entries (XAUTOCLAIM)', () => {
  test('crash before claim: another worker takes over the entry and runs the job once', async () => {
    const job = await submit({ name: 'test.ok' });
    await publishAll();
    const dead = await crashedWorker();
    assert.equal((await deliver(dead)).length, 1); // read, never claimed

    const live = await makeWorker({ config: { pendingIdleMs: 0 } });
    assert.deepEqual(await processReclaimed(live), [{ outcome: 'completed', acked: true }]);
    assert.deepEqual(calls, [job.id]);
    assert.equal((await jobRow(job.id)).status, 'COMPLETED');
    assert.equal(await pendingCount(), 0);
  });

  test('crash after the DB outcome but before XACK: the entry is discarded without re-running', async () => {
    const job = await submit({ name: 'test.ok' });
    await publishAll();
    const dead = await crashedWorker();
    await deliver(dead);
    const claim = await jobExecutionRepository.claim({ jobId: job.id, queueId: queue.id, workerId: dead.workerId, leaseMs: 30_000 });
    assert.equal(await jobExecutionRepository.complete(claim, { result: { done: true } }), true);

    const live = await makeWorker({ config: { pendingIdleMs: 0 } });
    assert.deepEqual(await processReclaimed(live), [{ outcome: 'discarded:terminal', acked: true }]);
    assert.deepEqual(calls, []);
    assert.equal(await pendingCount(), 0);
  });

  test('entries that are not idle long enough are left with their consumer', async () => {
    await submit({ name: 'test.ok' });
    await publishAll();
    const other = await crashedWorker();
    await deliver(other);

    const live = await makeWorker({ config: { pendingIdleMs: 60_000 } });
    assert.deepEqual(await processReclaimed(live), []);
    assert.equal(await pendingCount(), 1);
  });

  test('a worker does not take over entries it is already processing', async () => {
    const job = await submit({ name: 'test.slow', payload: { ms: 300 } });
    await publishAll();
    const worker = await makeWorker({ config: { pendingIdleMs: 0 } });
    const [entry] = await deliver(worker);
    worker.activeEntries.add(`${entry.streamKey}|${entry.id}`);
    const running = process1(worker, entry);

    await worker.refreshQueues();
    assert.equal(await worker.claimStalePending(10), 0);
    assert.deepEqual(await running, { outcome: 'completed', acked: true });
    assert.deepEqual(calls, [job.id]);
  });
});

describe('heartbeat and worker health', () => {
  test('running workers heartbeat; silent ones are marked UNHEALTHY and recover on their next beat', async () => {
    const worker = await makeWorker({ config: { heartbeatMs: 50 } });
    const silent = await makeWorker();
    const stopped = await makeWorker();
    await sql(`UPDATE workers SET last_heartbeat_at = NOW() - INTERVAL '1 hour' WHERE id IN ($1, $2)`, [silent.workerId, stopped.workerId]);
    await sql(`UPDATE workers SET status = 'STOPPED' WHERE id = $1`, [stopped.workerId]);
    const status = async (id) => (await sql(`SELECT status, last_heartbeat_at FROM workers WHERE id = $1`, [id]))[0];

    await worker.start();
    const before = (await status(worker.workerId)).last_heartbeat_at;
    await waitFor(async () => (await status(worker.workerId)).last_heartbeat_at > before);

    const result = await makeRecovery({ heartbeatTimeoutMs: 1000 }).runOnce();
    assert.equal(result.unhealthyWorkers, 1);
    assert.equal((await status(silent.workerId)).status, 'UNHEALTHY');
    assert.equal((await status(stopped.workerId)).status, 'STOPPED', 'stopped workers are not touched');
    assert.equal((await status(worker.workerId)).status, 'RUNNING');

    // The silent worker comes back.
    await silent.heartbeat();
    assert.equal((await status(silent.workerId)).status, 'RUNNING');

    await worker.stop();
    assert.equal((await status(worker.workerId)).status, 'STOPPED');
    await worker.heartbeat();
    assert.equal((await status(worker.workerId)).status, 'STOPPED', 'a late heartbeat never revives a stopped worker');
  });
});

describe('end to end with running processes', () => {
  test('retries flow through recovery and the publisher until success or a terminal state', async () => {
    const worker = await makeWorker({ config: { retryBaseMs: 20, retryMaxMs: 50 } });
    const publisher = newPublisher();
    const recovery = makeRecovery();
    await worker.start();
    publisher.start();
    recovery.start();
    try {
      const flaky = await submit({ name: 'test.flaky', maxAttempts: 3 });
      const doomed = await submit({ name: 'test.fail', maxAttempts: 3 });

      await waitFor(async () => (await jobRow(flaky.id)).status === 'COMPLETED');
      await waitFor(async () => (await jobRow(doomed.id)).status === 'DEAD');

      assert.deepEqual((await attemptRows(flaky.id)).map((a) => a.status), ['FAILED', 'SUCCEEDED']);
      assert.deepEqual((await attemptRows(doomed.id)).map((a) => a.status), ['FAILED', 'FAILED', 'FAILED']);
      assert.equal((await jobRow(doomed.id)).attempts_made, 3);
    } finally {
      await worker.stop();
      await publisher.stop();
    }
    assert.equal(await pendingCount(), 0);
  });
});
