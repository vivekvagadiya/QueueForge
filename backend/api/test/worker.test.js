import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { getDatabase } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { closeRedis } from '../src/config/redis.js';
import { logger } from '../src/config/logger.js';
import { OutboxPublisher } from '../src/outbox/outboxPublisher.js';
import { jobExecutionRepository } from '../src/repositories/jobExecution.repository.js';
import { jobStreamKey } from '../src/streams/jobStream.js';
import { NonRetryableError } from '../src/worker/errors.js';
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
  shutdownGraceMs: 5000,
  retryBaseMs: 1000,
  retryMaxMs: 60_000,
};

let redis;
let owner;
let queue;
let calls;
let readers;

const sql = async (query, bind = []) => (await getDatabase().query(query, { bind }))[0];

const testRegistry = () => {
  const registry = new HandlerRegistry();
  const active = { now: 0, max: 0 };
  registry.active = active;
  registry
    .register('test.ok', async ({ job }) => {
      calls.push(job.id);
      return { ok: true, attempt: job.attempt };
    })
    .register('test.fail', async ({ job }) => {
      calls.push(job.id);
      throw new Error('boom');
    })
    .register('test.permanent', async () => {
      throw new NonRetryableError('bad payload', { code: 'BAD_PAYLOAD' });
    })
    .register('test.bigint', async () => ({ n: 1n }))
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
    .register('test.stolen', async ({ job }) => {
      // Simulates recovery handing the job to another owner mid-execution.
      calls.push(job.id);
      await sql(`UPDATE jobs SET lease_version = lease_version + 1, locked_by = gen_random_uuid() WHERE id = $1`, [
        job.id,
      ]);
      return { ok: true };
    });
  return registry;
};

const makeWorker = async ({ registry = testRegistry(), config = {}, repository } = {}) => {
  const reader = await connectTestRedis();
  readers.push(reader);
  const worker = new Worker({
    reader,
    commands: redis,
    registry,
    logger,
    config: { ...CONFIG, ...config },
    repository,
  });
  await worker.register();
  return worker;
};

const publishAll = () =>
  new OutboxPublisher({
    redis,
    logger,
    config: { pollIntervalMs: 20, batchSize: 100, claimTimeoutMs: 30_000, baseMs: 1000, maxMs: 60_000 },
  }).runOnce();

const submit = async (body, queueId = queue.id) => {
  const res = await request(app)
    .post(`/api/v1/queues/${queueId}/jobs`)
    .set('Authorization', owner.auth)
    .send(body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};

/** Delivers up to `count` new entries to this worker's consumer (as XREADGROUP would). */
const deliver = async (worker, count = 10) => {
  await worker.refreshQueues();
  const res = await redis.xreadgroup(
    'GROUP', GROUP, worker.consumerName, 'COUNT', count,
    'STREAMS', jobStreamKey(queue.id), '>'
  );
  return res ? res[0][1].map(([id, fields]) => ({ streamKey: res[0][0], id, fields })) : [];
};

const process1 = (worker, e) => worker.processEntry(e.streamKey, e.id, e.fields);

const pendingCount = async () => {
  try {
    return Number((await redis.xpending(jobStreamKey(queue.id), GROUP))[0]);
  } catch {
    return 0; // no group yet
  }
};

const jobRow = async (id) =>
  (await sql(`SELECT status, result, last_error, locked_by, lease_version, attempts_made,
                     scheduled_at > NOW() AS deferred, completed_at FROM jobs WHERE id = $1`, [id]))[0];

const attemptRows = (id) =>
  sql(`SELECT attempt_number, worker_id, status, lease_version, error_code, error_message, result, duration_ms
       FROM job_attempts WHERE job_id = $1 ORDER BY attempt_number`, [id]);

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
  owner = await createUser();
  queue = await createQueue(owner.auth, { name: 'work' });
});
afterEach(async () => {
  await Promise.all(readers.map((r) => closeRedis(r)));
});

describe('claim, execute, persist, acknowledge', () => {
  test('a published job is claimed, executed once, completed, and acknowledged', async () => {
    const job = await submit({ name: 'test.ok' });
    await publishAll(); // published before the consumer group exists: group starts at ID 0
    const worker = await makeWorker();

    const [entry] = await deliver(worker);
    assert.deepEqual(await process1(worker, entry), { outcome: 'completed', acked: true });

    assert.deepEqual(calls, [job.id]);
    const row = await jobRow(job.id);
    assert.equal(row.status, 'COMPLETED');
    assert.deepEqual(row.result, { ok: true, attempt: 1 });
    assert.equal(row.locked_by, null);
    assert.equal(row.lease_version, '1');
    assert.ok(row.completed_at);

    const [attempt] = await attemptRows(job.id);
    assert.equal(attempt.status, 'SUCCEEDED');
    assert.equal(attempt.worker_id, worker.workerId);
    assert.equal(attempt.lease_version, '1');
    assert.ok(attempt.duration_ms >= 0);
    assert.equal(await pendingCount(), 0);
  });

  test('duplicate stream entries for one job run the handler once and are all acknowledged', async () => {
    const job = await submit({ name: 'test.ok' });
    await publishAll();
    const [[, fields]] = await redis.xrange(jobStreamKey(queue.id), '-', '+');
    await redis.xadd(jobStreamKey(queue.id), '*', ...fields); // duplicate publication
    const worker = await makeWorker();

    const entries = await deliver(worker);
    assert.equal(entries.length, 2);
    const outcomes = [];
    for (const e of entries) outcomes.push((await process1(worker, e)).outcome);

    assert.deepEqual(outcomes, ['completed', 'discarded:terminal']);
    assert.deepEqual(calls, [job.id]);
    assert.equal((await attemptRows(job.id)).length, 1);
    assert.equal(await pendingCount(), 0);
  });

  test('two workers receiving the same job concurrently cannot both execute it', async () => {
    for (let round = 0; round < 10; round += 1) {
      await resetDatabase();
      await clearTestStreams(redis);
      calls = [];
      owner = await createUser();
      queue = await createQueue(owner.auth, { name: `race-${round}` });

      const job = await submit({ name: 'test.slow', payload: { ms: 30 } });
      await publishAll();
      const [[, fields]] = await redis.xrange(jobStreamKey(queue.id), '-', '+');
      await redis.xadd(jobStreamKey(queue.id), '*', ...fields);

      const a = await makeWorker();
      const b = await makeWorker();
      const [ea] = await deliver(a, 1);
      const [eb] = await deliver(b, 1);
      const results = await Promise.all([process1(a, ea), process1(b, eb)]);

      assert.deepEqual(calls, [job.id], `round ${round}: handler ran ${calls.length} times`);
      assert.deepEqual(
        results.map((r) => r.outcome).sort(),
        ['completed', results.find((r) => r.outcome !== 'completed').outcome].sort()
      );
      assert.ok(['discarded:active', 'discarded:terminal'].includes(results.find((r) => r.outcome !== 'completed').outcome));
      assert.equal((await attemptRows(job.id)).length, 1);
      assert.equal(await pendingCount(), 0);
    }
  });

  test('entries that cannot be claimed never run a handler', async () => {
    const scheduled = await submit({ name: 'test.ok', delayMs: 60_000 });
    const other = await createQueue(owner.auth, { name: 'other' });
    const key = jobStreamKey(queue.id);
    const worker = await makeWorker();
    await worker.refreshQueues();

    await redis.xadd(key, '*', 'jobId', scheduled.id, 'queueId', queue.id);
    await redis.xadd(key, '*', 'jobId', '00000000-0000-4000-8000-000000000000', 'queueId', queue.id);
    await redis.xadd(key, '*', 'jobId', scheduled.id, 'queueId', other.id);
    await redis.xadd(key, '*', 'garbage', 'yes');

    const outcomes = [];
    for (const e of await deliver(worker)) outcomes.push((await process1(worker, e)).outcome);

    assert.deepEqual(outcomes, [
      'discarded:scheduled',
      'discarded:unknown-job',
      'discarded:unknown-job',
      'discarded:malformed',
    ]);
    assert.deepEqual(calls, []);
    assert.equal((await jobRow(scheduled.id)).status, 'SCHEDULED');
    assert.equal(await pendingCount(), 0);
  });
});

describe('database failures never cause premature acknowledgement', () => {
  test('a claim error leaves the entry pending and does not execute', async () => {
    const job = await submit({ name: 'test.ok' });
    await publishAll();
    const worker = await makeWorker({
      repository: {
        ...jobExecutionRepository,
        claim: async () => {
          throw new Error('connection terminated');
        },
      },
    });

    const [entry] = await deliver(worker);
    assert.deepEqual(await process1(worker, entry), { outcome: 'pending:claim-error', acked: false });
    assert.deepEqual(calls, []);
    assert.equal((await jobRow(job.id)).status, 'WAITING');
    assert.equal(await pendingCount(), 1);
  });

  test('a persist error leaves the entry pending and the job ACTIVE under its lease', async () => {
    const job = await submit({ name: 'test.ok' });
    await publishAll();
    const worker = await makeWorker({
      repository: {
        ...jobExecutionRepository,
        complete: async () => {
          throw new Error('connection terminated');
        },
      },
    });

    const [entry] = await deliver(worker);
    assert.deepEqual(await process1(worker, entry), { outcome: 'pending:persist-error', acked: false });
    const row = await jobRow(job.id);
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.locked_by, worker.workerId);
    assert.equal(await pendingCount(), 1);
  });
});

describe('failure outcomes', () => {
  const runOne = async (body) => {
    const job = await submit(body);
    await publishAll();
    const worker = await makeWorker();
    const [entry] = await deliver(worker);
    const result = await process1(worker, entry);
    return { job, result, row: await jobRow(job.id), attempts: await attemptRows(job.id) };
  };

  test('a retryable failure with attempts left moves the job to RETRYING with a future time', async () => {
    const { result, row, attempts } = await runOne({ name: 'test.fail', maxAttempts: 3 });
    assert.deepEqual(result, { outcome: 'retrying', acked: true });
    assert.equal(row.status, 'RETRYING');
    assert.equal(row.deferred, true);
    assert.equal(row.locked_by, null);
    assert.deepEqual(row.last_error, { code: 'Error', message: 'boom', attempt: 1 });
    assert.equal(attempts[0].status, 'FAILED');
    assert.equal(attempts[0].error_message, 'boom');
  });

  test('the last allowed attempt failing makes the job DEAD', async () => {
    const { result, row } = await runOne({ name: 'test.fail', maxAttempts: 1 });
    assert.equal(result.outcome, 'dead');
    assert.equal(row.status, 'DEAD');
    assert.ok(row.completed_at);
  });

  test('non-retryable errors, unknown handlers, and unserializable results fail permanently', async () => {
    const cases = [
      ['test.permanent', 'BAD_PAYLOAD'],
      ['no.such.handler', 'HANDLER_NOT_FOUND'],
      ['test.bigint', 'RESULT_NOT_SERIALIZABLE'],
    ];
    for (const [name, code] of cases) {
      const { result, row, attempts } = await runOne({ name, maxAttempts: 5 });
      assert.equal(result.outcome, 'failed', name);
      assert.equal(row.status, 'FAILED', name);
      assert.equal(row.last_error.code, code, name);
      assert.equal(attempts[0].error_code, code, name);
    }
    assert.equal(await pendingCount(), 0);
  });
});

describe('fencing', () => {
  test('a worker whose lease was taken over cannot record its outcome', async () => {
    const job = await submit({ name: 'test.stolen' });
    await publishAll();
    const worker = await makeWorker();

    const [entry] = await deliver(worker);
    assert.deepEqual(await process1(worker, entry), { outcome: 'fenced', acked: true });

    const row = await jobRow(job.id);
    assert.equal(row.status, 'ACTIVE', 'the new owner still holds the job');
    assert.notEqual(row.locked_by, worker.workerId);
    assert.equal(row.result, null);
    assert.equal((await attemptRows(job.id))[0].status, 'RUNNING');
  });

  test('outcome writes require the exact worker and lease version', async () => {
    const job = await submit({ name: 'test.ok' });
    const worker = await makeWorker();
    const claim = await jobExecutionRepository.claim({
      jobId: job.id,
      queueId: queue.id,
      workerId: worker.workerId,
      leaseMs: 30_000,
    });
    assert.equal(claim.leaseVersion, '1');

    assert.equal(await jobExecutionRepository.complete({ ...claim, leaseVersion: '0' }, { result: {} }), false);
    assert.equal(
      await jobExecutionRepository.complete({ ...claim, workerId: '00000000-0000-4000-8000-000000000000' }, { result: {} }),
      false
    );
    assert.equal((await jobRow(job.id)).status, 'ACTIVE');
    assert.equal(await jobExecutionRepository.complete(claim, { result: { done: 1 } }), true);
    assert.equal((await jobRow(job.id)).status, 'COMPLETED');

    // A second claim of a finished job is impossible.
    assert.equal(
      await jobExecutionRepository.claim({ jobId: job.id, queueId: queue.id, workerId: worker.workerId, leaseMs: 1000 }),
      null
    );
  });
});

describe('worker loop', () => {
  const waitFor = async (check, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      assert.ok(Date.now() < deadline, 'condition not met in time');
      await delay(25);
    }
  };
  const countStatus = async (status) =>
    Number((await sql(`SELECT COUNT(*)::int AS n FROM jobs WHERE status = $1`, [status]))[0].n);

  test('processes jobs from multiple queues within its concurrency limit, then stops cleanly', async () => {
    const registry = testRegistry();
    const worker = await makeWorker({ registry, config: { concurrency: 2 } });
    await worker.start();
    try {
      // Three streams with two free slots: one XREADGROUP can return three
      // entries (COUNT is per stream), exercising the local backlog.
      const queue2 = await createQueue(owner.auth, { name: 'work-2' });
      const queue3 = await createQueue(owner.auth, { name: 'work-3' });
      for (const q of [queue.id, queue2.id, queue3.id]) {
        for (let i = 0; i < 2; i += 1) await submit({ name: 'test.slow', payload: { ms: 80 } }, q);
      }
      await publishAll();

      await waitFor(async () => (await countStatus('COMPLETED')) === 6);
      assert.equal(registry.active.max, 2, 'worker-local concurrency limit');
      assert.equal(calls.length, 6);
    } finally {
      await worker.stop();
    }
    const [row] = await sql(`SELECT status, stopped_at FROM workers WHERE id = $1`, [worker.workerId]);
    assert.equal(row.status, 'STOPPED');
    assert.ok(row.stopped_at);
  });

  test('stop() waits for in-flight jobs to finish within the grace period', async () => {
    const worker = await makeWorker();
    await worker.start();
    const job = await submit({ name: 'test.slow', payload: { ms: 300 } });
    await publishAll();
    await waitFor(async () => (await jobRow(job.id)).status === 'ACTIVE');

    await worker.stop();
    assert.equal((await jobRow(job.id)).status, 'COMPLETED');
    assert.equal(await pendingCount(), 0);
  });

  test('jobs aborted when the grace period ends are handed back as INTERRUPTED, not completed or failed', async () => {
    const worker = await makeWorker({ config: { shutdownGraceMs: 50 } });
    await worker.start();
    const job = await submit({ name: 'test.slow', payload: { ms: 10_000 }, maxAttempts: 3 });
    await publishAll();
    await waitFor(async () => (await jobRow(job.id)).status === 'ACTIVE');

    await worker.stop();
    const row = await jobRow(job.id);
    assert.equal(row.status, 'RETRYING');
    assert.equal(row.locked_by, null);
    assert.equal(row.last_error.code, 'WORKER_SHUTDOWN');
    const [attempt] = await attemptRows(job.id);
    assert.equal(attempt.status, 'INTERRUPTED');
    assert.equal(attempt.error_code, 'WORKER_SHUTDOWN');
    assert.equal(await pendingCount(), 0, 'retry release will emit a new event');
  });

  test('if handing an aborted job back fails, it stays ACTIVE and its entry pending for lease recovery', async () => {
    const worker = await makeWorker({
      config: { shutdownGraceMs: 50 },
      repository: {
        ...jobExecutionRepository,
        fail: async () => {
          throw new Error('connection terminated');
        },
      },
    });
    await worker.start();
    const job = await submit({ name: 'test.slow', payload: { ms: 10_000 } });
    await publishAll();
    await waitFor(async () => (await jobRow(job.id)).status === 'ACTIVE');

    await worker.stop();
    assert.equal((await jobRow(job.id)).status, 'ACTIVE');
    assert.equal((await attemptRows(job.id))[0].status, 'RUNNING');
    assert.equal(await pendingCount(), 1);
  });
});
