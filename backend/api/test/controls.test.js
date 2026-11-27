import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { getDatabase } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { closeRedis } from '../src/config/redis.js';
import { logger } from '../src/config/logger.js';
import { OutboxPublisher } from '../src/outbox/outboxPublisher.js';
import { RecoveryService } from '../src/recovery/recoveryService.js';
import { RetentionService } from '../src/recovery/retentionService.js';
import { jobExecutionRepository } from '../src/repositories/jobExecution.repository.js';
import { recoveryRepository } from '../src/repositories/recovery.repository.js';
import { workerRepository } from '../src/repositories/worker.repository.js';
import { ensureConsumerGroup, jobStreamKey } from '../src/streams/jobStream.js';
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
  cancelCheckMs: 50,
  capacityRetryBaseMs: 20,
  capacityRetryMaxMs: 100,
  shutdownGraceMs: 5000,
  retryBaseMs: 1000,
  retryMaxMs: 60_000,
};

let redis;
let owner;
let queue;
let calls;
let readers;
let workers;
let active;

const sql = async (query, bind = []) => (await getDatabase().query(query, { bind }))[0];

const testRegistry = () =>
  new HandlerRegistry()
    .register('test.ok', async ({ job }) => {
      calls.push(job.id);
      return { ok: true };
    })
    .register('test.fail', async ({ job }) => {
      calls.push(job.id);
      throw new Error('boom');
    })
    .register('test.slow', async ({ job, signal }) => {
      calls.push(job.id);
      active.now += 1;
      active.max = Math.max(active.max, active.now);
      try {
        await delay(job.payload.ms ?? 100, undefined, { signal });
        return { slept: true };
      } finally {
        active.now -= 1;
      }
    })
    // Ignores its abort signal: keeps running after a cancel request.
    .register('test.stubborn', async ({ job }) => {
      calls.push(job.id);
      await delay(job.payload.ms ?? 300);
      if (job.payload.fail) throw new Error('failed after cancel request');
      return { finished: true };
    });

const makeWorker = async (config = {}) => {
  const reader = await connectTestRedis();
  readers.push(reader);
  const worker = new Worker({ reader, commands: redis, registry: testRegistry(), logger, config: { ...CONFIG, ...config } });
  await worker.register();
  workers.push(worker);
  return worker;
};

const publishAll = () =>
  new OutboxPublisher({
    redis,
    logger,
    config: { pollIntervalMs: 20, batchSize: 100, claimTimeoutMs: 30_000, baseMs: 1000, maxMs: 60_000 },
  }).runOnce();

const api = (method, path, auth = owner.auth) => request(app)[method](`/api/v1${path}`).set('Authorization', auth);

const submit = async (body, queueId = queue.id) => {
  const res = await api('post', `/queues/${queueId}/jobs`).send(body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};

const deliver = async (worker, count = 10, queueId = queue.id) => {
  await worker.refreshQueues();
  const res = await redis.xreadgroup(
    'GROUP', GROUP, worker.consumerName, 'COUNT', count, 'STREAMS', jobStreamKey(queueId), '>'
  );
  return res ? res[0][1].map(([id, fields]) => ({ streamKey: res[0][0], id, fields })) : [];
};

const process1 = (worker, e) => worker.processEntry(e.streamKey, e.id, e.fields);

const jobRow = async (id) =>
  (await sql(`SELECT status, scheduled_at, completed_at, cancel_requested_at, attempts_made, last_error
              FROM jobs WHERE id = $1`, [id]))[0];

const attemptRows = (id) =>
  sql(`SELECT attempt_number, status, error_code FROM job_attempts WHERE job_id = $1 ORDER BY attempt_number`, [id]);

const outboxCount = async (jobId) =>
  Number((await sql(`SELECT COUNT(*)::int AS n FROM outbox_events WHERE aggregate_id = $1`, [jobId]))[0].n);

const pendingCount = async (queueId = queue.id) => {
  try {
    return Number((await redis.xpending(jobStreamKey(queueId), GROUP))[0]);
  } catch {
    return 0;
  }
};

const waitFor = async (check, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'condition not met in time');
    await delay(20);
  }
};

const recovery = () =>
  new RecoveryService({
    logger,
    config: { intervalMs: 50, batchSize: 100, heartbeatTimeoutMs: 30_000, retryBaseMs: 1, retryMaxMs: 10 },
  });

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
  workers = [];
  active = { now: 0, max: 0 };
  owner = await createUser();
  queue = await createQueue(owner.auth, { name: 'controls', concurrency: 10 });
});
afterEach(async () => {
  await Promise.all(workers.map((w) => w.stop()));
  await Promise.all(readers.map((r) => closeRedis(r)));
});

// -----------------------------------------------------------------------------
describe('scheduled jobs', () => {
  test('a delayed job is released at its time with a job.ready event, then runs', async () => {
    const job = await submit({ name: 'test.ok', delayMs: 400 });
    assert.equal(job.status, 'SCHEDULED');
    assert.equal(await outboxCount(job.id), 0, 'no event before release');

    assert.deepEqual(await recoveryRepository.releaseDueScheduled({ limit: 10 }), [], 'not due yet');
    assert.equal((await jobRow(job.id)).status, 'SCHEDULED');

    await delay(450);
    assert.deepEqual(await recoveryRepository.releaseDueScheduled({ limit: 10 }), [job.id]);
    assert.equal((await jobRow(job.id)).status, 'WAITING');
    assert.equal(await outboxCount(job.id), 1);

    await publishAll();
    const worker = await makeWorker();
    const [entry] = await deliver(worker);
    assert.deepEqual(await process1(worker, entry), { outcome: 'completed', acked: true });
  });

  test('the recovery loop releases a job scheduled with scheduledAt close to its time', async () => {
    const runAt = new Date(Date.now() + 500);
    const job = await submit({ name: 'test.ok', scheduledAt: runAt.toISOString() });
    assert.equal(job.status, 'SCHEDULED');

    const service = recovery();
    service.start();
    try {
      await waitFor(async () => (await jobRow(job.id)).status === 'WAITING');
    } finally {
      await service.stop();
    }
    const releasedAt = Date.now();
    assert.ok(releasedAt >= runAt.getTime() - 50, 'not released early');
    assert.ok(releasedAt - runAt.getTime() < 1000, `released within one interval (${releasedAt - runAt.getTime()}ms late)`);
  });

  test('concurrent recovery instances release each due job exactly once', async () => {
    const jobs = await Promise.all([1, 2, 3, 4].map(() => submit({ name: 'test.ok', delayMs: 100 })));
    await delay(150);
    const results = await Promise.all([1, 2, 3].map(() => recoveryRepository.releaseDueScheduled({ limit: 100 })));
    assert.deepEqual(results.flat().sort(), jobs.map((j) => j.id).sort());
    for (const job of jobs) assert.equal(await outboxCount(job.id), 1);
  });

  test('a cancelled scheduled job is never released', async () => {
    const job = await submit({ name: 'test.ok', delayMs: 100 });
    const res = await api('post', `/jobs/${job.id}/cancel`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'CANCELLED');
    await delay(150);
    assert.deepEqual(await recoveryRepository.releaseDueScheduled({ limit: 10 }), []);
    assert.equal(await outboxCount(job.id), 0);
  });
});

// -----------------------------------------------------------------------------
describe('queue pause and resume', () => {
  test('a paused queue accepts jobs but dispatches none; resume re-announces and they run', async () => {
    const paused = await api('post', `/queues/${queue.id}/pause`);
    assert.equal(paused.status, 200);
    assert.equal(paused.body.data.status, 'PAUSED');

    const job = await submit({ name: 'test.ok' });
    await publishAll();
    const worker = await makeWorker({ queueIds: [queue.id] });
    const [entry] = await deliver(worker);
    assert.deepEqual(await process1(worker, entry), { outcome: 'discarded:queue-not-active', acked: true });
    assert.equal((await jobRow(job.id)).status, 'WAITING');
    assert.deepEqual(calls, []);
    assert.equal(await pendingCount(), 0);

    const resumed = await api('post', `/queues/${queue.id}/resume`);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.data.status, 'ACTIVE');
    assert.equal(await outboxCount(job.id), 2, 'resume emitted a fresh job.ready');

    await publishAll();
    const [again] = await deliver(worker);
    assert.deepEqual(await process1(worker, again), { outcome: 'completed', acked: true });
    assert.deepEqual(calls, [job.id]);
  });

  test('a claim racing a pause is serialized by the queue lock', async () => {
    const job = await submit({ name: 'test.ok' });
    const worker = await makeWorker();
    // Hold the queue row lock as an in-flight pause would, then commit the pause.
    const db = getDatabase();
    const tx = await db.transaction();
    await db.query(`SELECT id FROM queues WHERE id = $1 FOR NO KEY UPDATE`, { bind: [queue.id], transaction: tx });
    const claiming = jobExecutionRepository.claim({ jobId: job.id, queueId: queue.id, workerId: worker.workerId, leaseMs: 30_000 });
    await delay(100);
    await db.query(`UPDATE queues SET status = 'PAUSED' WHERE id = $1`, { bind: [queue.id], transaction: tx });
    await tx.commit();

    const claim = await claiming;
    assert.equal(claim.rejected, 'QUEUE_NOT_ACTIVE', 'the claim saw the committed pause');
    assert.equal((await jobRow(job.id)).status, 'WAITING');
  });

  test('pause and resume are idempotent, owner-scoped, and refuse archived queues', async () => {
    assert.equal((await api('post', `/queues/${queue.id}/pause`)).status, 200);
    assert.equal((await api('post', `/queues/${queue.id}/pause`)).status, 200);
    assert.equal((await api('post', `/queues/${queue.id}/resume`)).status, 200);
    assert.equal((await api('post', `/queues/${queue.id}/resume`)).status, 200);

    const stranger = await createUser();
    assert.equal((await api('post', `/queues/${queue.id}/pause`, stranger.auth)).status, 404);

    await api('patch', `/queues/${queue.id}`).send({ status: 'ARCHIVED' });
    const res = await api('post', `/queues/${queue.id}/resume`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'QUEUE_ARCHIVED');
    assert.equal((await api('post', `/queues/${queue.id}/pause`)).status, 409);
  });

  test('a PATCH back to ACTIVE also re-announces waiting jobs; workers skip paused streams', async () => {
    const job = await submit({ name: 'test.ok' });
    await api('patch', `/queues/${queue.id}`).send({ status: 'PAUSED' });
    assert.ok(!(await workerRepository.listConsumableQueueIds()).includes(queue.id));

    await api('patch', `/queues/${queue.id}`).send({ status: 'ACTIVE' });
    assert.ok((await workerRepository.listConsumableQueueIds()).includes(queue.id));
    assert.equal(await outboxCount(job.id), 2);

    // A change that keeps the queue ACTIVE emits nothing.
    await api('patch', `/queues/${queue.id}`).send({ description: 'still active' });
    assert.equal(await outboxCount(job.id), 2);
  });
});

// -----------------------------------------------------------------------------
describe('cancellation', () => {
  test('a waiting job is cancelled at once and never runs', async () => {
    const job = await submit({ name: 'test.ok' });
    await publishAll();
    const res = await api('post', `/jobs/${job.id}/cancel`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'CANCELLED');
    assert.ok(res.body.data.cancelRequestedAt);
    assert.ok(res.body.data.completedAt);

    const worker = await makeWorker();
    const [entry] = await deliver(worker);
    assert.deepEqual(await process1(worker, entry), { outcome: 'discarded:terminal', acked: true });
    assert.deepEqual(calls, []);
  });

  test('a retrying job is cancelled at once and not released', async () => {
    const job = await submit({ name: 'test.fail', maxAttempts: 3 });
    await publishAll();
    const worker = await makeWorker();
    const [entry] = await deliver(worker);
    assert.equal((await process1(worker, entry)).outcome, 'retrying');

    const res = await api('post', `/jobs/${job.id}/cancel`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'CANCELLED');
    await sql(`UPDATE jobs SET scheduled_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [job.id]);
    assert.deepEqual(await recoveryRepository.releaseDueRetries({ limit: 10 }), []);
  });

  test('cancelling is idempotent; finished jobs return 409; other users get 404', async () => {
    const waiting = await submit({ name: 'test.ok' });
    assert.equal((await api('post', `/jobs/${waiting.id}/cancel`)).status, 200);
    const again = await api('post', `/jobs/${waiting.id}/cancel`);
    assert.equal(again.status, 200);
    assert.equal(again.body.data.status, 'CANCELLED');

    const done = await submit({ name: 'test.ok' });
    await publishAll();
    const worker = await makeWorker();
    for (const e of await deliver(worker)) await process1(worker, e);
    assert.equal((await jobRow(done.id)).status, 'COMPLETED');
    const res = await api('post', `/jobs/${done.id}/cancel`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'JOB_NOT_CANCELLABLE');

    const stranger = await createUser();
    assert.equal((await api('post', `/jobs/${done.id}/cancel`, stranger.auth)).status, 404);
  });

  test('a running job stays ACTIVE until its handler stops, then becomes CANCELLED', async () => {
    const job = await submit({ name: 'test.slow', payload: { ms: 10_000 } });
    await publishAll();
    const worker = await makeWorker();
    const [entry] = await deliver(worker);
    const running = process1(worker, entry);
    await waitFor(async () => (await jobRow(job.id)).status === 'ACTIVE');

    const res = await api('post', `/jobs/${job.id}/cancel`);
    assert.equal(res.status, 202);
    assert.equal(res.body.data.status, 'ACTIVE', 'not reported as cancelled while the handler runs');
    assert.ok(res.body.data.cancelRequestedAt);

    const started = Date.now();
    await worker.checkCancellations();
    assert.deepEqual(await running, { outcome: 'cancelled', acked: true });
    assert.ok(Date.now() - started < 2000, 'handler stopped promptly');

    const row = await jobRow(job.id);
    assert.equal(row.status, 'CANCELLED');
    assert.ok(row.completed_at);
    const attempts = await attemptRows(job.id);
    assert.deepEqual(attempts.map((a) => [a.status, a.error_code]), [['CANCELLED', 'CANCELLED']]);
  });

  test('a handler that ignores the signal keeps the job ACTIVE until it returns, and its success is recorded', async () => {
    const job = await submit({ name: 'test.stubborn', payload: { ms: 600 } });
    await publishAll();
    const worker = await makeWorker();
    worker.cancelTimer = setInterval(() => worker.checkCancellations(), 50);
    const [entry] = await deliver(worker);
    const running = process1(worker, entry);
    await waitFor(async () => (await jobRow(job.id)).status === 'ACTIVE');

    assert.equal((await api('post', `/jobs/${job.id}/cancel`)).status, 202);
    await delay(250); // several cancel checks have fired; the handler is still running
    const midway = await api('get', `/jobs/${job.id}`);
    assert.equal(midway.body.data.status, 'ACTIVE');

    assert.deepEqual(await running, { outcome: 'completed', acked: true });
    clearInterval(worker.cancelTimer);
    assert.equal((await jobRow(job.id)).status, 'COMPLETED');
  });

  test('a handler failing after a cancel request is CANCELLED, not retried', async () => {
    const job = await submit({ name: 'test.stubborn', payload: { ms: 300, fail: true }, maxAttempts: 5 });
    await publishAll();
    const worker = await makeWorker();
    const [entry] = await deliver(worker);
    const running = process1(worker, entry);
    await waitFor(async () => (await jobRow(job.id)).status === 'ACTIVE');
    assert.equal((await api('post', `/jobs/${job.id}/cancel`)).status, 202);

    assert.deepEqual(await running, { outcome: 'cancelled', acked: true });
    assert.equal((await jobRow(job.id)).status, 'CANCELLED');
    assert.deepEqual((await attemptRows(job.id)).map((a) => a.status), ['FAILED']);
  });

  test('an expired lease on a job with a cancel request is recovered as CANCELLED', async () => {
    const job = await submit({ name: 'test.ok', maxAttempts: 5 });
    const worker = await makeWorker();
    await jobExecutionRepository.claim({ jobId: job.id, queueId: queue.id, workerId: worker.workerId, leaseMs: 30_000 });
    assert.equal((await api('post', `/jobs/${job.id}/cancel`)).status, 202);
    await sql(`UPDATE jobs SET lock_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [job.id]);

    const [recovered] = await recoveryRepository.recoverExpiredLeases({ limit: 10, retryBaseMs: 1, retryMaxMs: 1 });
    assert.equal(recovered.status, 'CANCELLED');
    const row = await jobRow(job.id);
    assert.equal(row.status, 'CANCELLED');
    assert.ok(row.completed_at);
    assert.deepEqual((await attemptRows(job.id)).map((a) => a.status), ['INTERRUPTED']);
  });
});

// -----------------------------------------------------------------------------
describe('queue concurrency limits', () => {
  test('simultaneous claims never exceed queues.concurrency', async () => {
    await api('patch', `/queues/${queue.id}`).send({ concurrency: 2 });
    const jobs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => submit({ name: 'test.ok' })));
    const worker = await makeWorker();

    const results = await Promise.all(
      jobs.map((j) => jobExecutionRepository.claim({ jobId: j.id, queueId: queue.id, workerId: worker.workerId, leaseMs: 30_000 }))
    );
    const claimed = results.filter((r) => r && !r.rejected);
    assert.equal(claimed.length, 2);
    assert.ok(results.filter((r) => r?.rejected).every((r) => r.rejected === 'QUEUE_AT_CAPACITY'));
    const [{ n }] = await sql(`SELECT COUNT(*)::int AS n FROM jobs WHERE queue_id = $1 AND status = 'ACTIVE'`, [queue.id]);
    assert.equal(n, 2);
  });

  test('an entry rejected for capacity stays pending and is claimed once a slot frees', async () => {
    await api('patch', `/queues/${queue.id}`).send({ concurrency: 1 });
    const first = await submit({ name: 'test.slow', payload: { ms: 300 } });
    const second = await submit({ name: 'test.ok' });
    await publishAll();
    const worker = await makeWorker();
    const [e1, e2] = await deliver(worker);

    const running = process1(worker, e1);
    await waitFor(async () => (await jobRow(first.id)).status === 'ACTIVE');
    assert.deepEqual(await process1(worker, e2), { outcome: 'deferred:queue-at-capacity', acked: false, deferred: true });
    assert.equal((await jobRow(second.id)).status, 'WAITING');
    assert.equal(await pendingCount(), 2, 'the deferred entry was not acknowledged');

    await running;
    assert.deepEqual(await process1(worker, e2), { outcome: 'completed', acked: true });
    assert.equal(await pendingCount(), 0);
  });

  test('the limit holds across worker processes running their loops', async () => {
    await api('patch', `/queues/${queue.id}`).send({ concurrency: 2 });
    const jobs = await Promise.all(
      Array.from({ length: 8 }, () => submit({ name: 'test.slow', payload: { ms: 150 } }))
    );
    await publishAll();
    const a = await makeWorker({ concurrency: 5 });
    const b = await makeWorker({ concurrency: 5 });
    await Promise.all([a.start(), b.start()]);

    await waitFor(async () => {
      const [{ n }] = await sql(`SELECT COUNT(*)::int AS n FROM jobs WHERE queue_id = $1 AND status = 'COMPLETED'`, [queue.id]);
      return n === jobs.length;
    }, 20_000);
    assert.ok(active.max <= 2, `at most 2 handlers ran at once (saw ${active.max})`);
    assert.equal(active.max, 2, 'both slots were used');
    await waitFor(async () => (await pendingCount()) === 0);
  });
});

// -----------------------------------------------------------------------------
describe('retention', () => {
  const RETENTION = {
    intervalMs: 60_000,
    batchSize: 2,
    completedJobMs: 60_000,
    failedJobMs: 120_000,
    outboxMs: 60_000,
    streamMs: 0,
    consumerMs: 0,
  };
  const retention = (config = {}, withRedis = false) =>
    new RetentionService({ logger, redis: withRedis ? redis : null, config: { ...RETENTION, ...config } });

  const finishedJob = async (status, ageMs) => {
    const job = await submit({ name: 'test.ok' });
    await sql(
      `UPDATE jobs SET status = $2, completed_at = NOW() - make_interval(secs => $3::double precision / 1000)
       WHERE id = $1`,
      [job.id, status, ageMs]
    );
    await sql(
      `INSERT INTO job_attempts (job_id, attempt_number, status, lease_version) VALUES ($1, 1, 'SUCCEEDED', 1)`,
      [job.id]
    );
    return job.id;
  };
  const exists = async (id) => (await sql(`SELECT 1 FROM jobs WHERE id = $1`, [id])).length === 1;

  test('deletes finished jobs (with attempts) and published events past their age; keeps the rest', async () => {
    const oldCompleted = await Promise.all([1, 2, 3].map(() => finishedJob('COMPLETED', 120_000)));
    const recentCompleted = await finishedJob('COMPLETED', 1000);
    const oldFailed = await finishedJob('DEAD', 180_000);
    const youngFailed = await finishedJob('FAILED', 90_000); // older than completedJobMs, younger than failedJobMs
    const oldCancelled = await finishedJob('CANCELLED', 180_000);
    const waiting = await submit({ name: 'test.ok' });

    await publishAll(); // every job.ready so far is now PUBLISHED
    await sql(`UPDATE outbox_events SET published_at = NOW() - INTERVAL '2 minutes'`);
    const pending = await submit({ name: 'test.ok' }); // its event stays PENDING

    const result = await retention().runOnce();
    assert.equal(result.completedJobs, 3, 'batched past batchSize');
    assert.equal(result.failedJobs, 2);

    for (const id of [...oldCompleted, oldFailed, oldCancelled]) assert.equal(await exists(id), false);
    for (const id of [recentCompleted, youngFailed, waiting.id, pending.id]) assert.equal(await exists(id), true);
    const [{ n: orphanAttempts }] = await sql(
      `SELECT COUNT(*)::int AS n FROM job_attempts a WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = a.job_id)`
    );
    assert.equal(orphanAttempts, 0);

    const statuses = await sql(`SELECT status, COUNT(*)::int AS n FROM outbox_events GROUP BY status`);
    assert.deepEqual(statuses, [{ status: 'PENDING', n: 1 }]);
  });

  test('an age of 0 keeps data forever', async () => {
    const id = await finishedJob('COMPLETED', 10 * 24 * 3600 * 1000);
    const result = await retention({ completedJobMs: 0, failedJobMs: 0, outboxMs: 0 }).runOnce();
    assert.equal(result.completedJobs, 0);
    assert.equal(await exists(id), true);
  });

  test('stream trimming removes only acknowledged entries, never pending or undelivered ones', async () => {
    const key = jobStreamKey(queue.id);
    await ensureConsumerGroup(redis, key, GROUP);
    const ids = [];
    for (let i = 0; i < 6; i += 1) ids.push(await redis.xadd(key, '*', 'n', String(i)));
    // Deliver 0..3; ack 0, 1 and 3; 2 stays pending; 4 and 5 are undelivered.
    await redis.xreadgroup('GROUP', GROUP, 'worker:test', 'COUNT', 4, 'STREAMS', key, '>');
    await redis.xack(key, GROUP, ids[0], ids[1], ids[3]);
    await delay(5);

    const service = retention({ streamMs: 1 }, true);
    const result = await service.runOnce();
    assert.equal(result.streamEntries, 2);
    const remaining = (await redis.xrange(key, '-', '+')).map(([id]) => id);
    assert.deepEqual(remaining, ids.slice(2), 'the pending entry and everything after it are kept');

    // With nothing pending, trimming stops at the first undelivered entry.
    await redis.xack(key, GROUP, ids[2]);
    await service.runOnce();
    assert.deepEqual((await redis.xrange(key, '-', '+')).map(([id]) => id), ids.slice(4));
  });

  test('a stream with no consumer group is never trimmed', async () => {
    const key = jobStreamKey(queue.id);
    await redis.xadd(key, '*', 'n', '1');
    await delay(5);
    const result = await retention({ streamMs: 1 }, true).runOnce();
    assert.equal(result.streamEntries, 0);
    assert.equal(await redis.xlen(key), 1);
  });

  test('deletes idle consumers of dead workers that hold no pending entries', async () => {
    const key = jobStreamKey(queue.id);
    await ensureConsumerGroup(redis, key, GROUP);
    await redis.xadd(key, '*', 'n', '1');
    const live = await makeWorker();
    const deadId = '00000000-0000-4000-8000-000000000001';
    const busyId = '00000000-0000-4000-8000-000000000002';
    // Touch consumers: dead has nothing pending; busy holds the only entry.
    await redis.xreadgroup('GROUP', GROUP, `worker:${busyId}`, 'COUNT', 1, 'STREAMS', key, '>');
    await redis.xreadgroup('GROUP', GROUP, `worker:${deadId}`, 'COUNT', 1, 'STREAMS', key, '>');
    await redis.xreadgroup('GROUP', GROUP, live.consumerName, 'COUNT', 1, 'STREAMS', key, '>');
    await redis.xreadgroup('GROUP', GROUP, 'someone-else', 'COUNT', 1, 'STREAMS', key, '>');
    await delay(350);
    await live.heartbeat(); // its row is fresh even though its consumer looks idle

    const result = await retention({ consumerMs: 300 }, true).runOnce();
    assert.equal(result.consumers, 1);
    const names = (await redis.xinfo('CONSUMERS', key, GROUP)).map((c) => c[1]).sort();
    assert.deepEqual(names, [live.consumerName, 'someone-else', `worker:${busyId}`].sort());
  });
});
