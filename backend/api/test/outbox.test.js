import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { getDatabase } from '../src/config/database.js';
import { closeRedis } from '../src/config/redis.js';
import { logger } from '../src/config/logger.js';
import { Job, OutboxEvent } from '../src/models/index.js';
import { OutboxPublisher } from '../src/outbox/outboxPublisher.js';
import { outboxRepository } from '../src/repositories/outbox.repository.js';
import { fromStreamFields, jobStreamKey } from '../src/streams/jobStream.js';
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

const CONFIG = { pollIntervalMs: 20, batchSize: 100, claimTimeoutMs: 30_000, baseMs: 1000, maxMs: 60_000 };

let redis;
let owner;
let queue;

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
  owner = await createUser();
  queue = await createQueue(owner.auth, { name: 'emails' });
});

afterEach(() => mock.restoreAll());

const submit = (body, { queueId = queue.id, headers = {} } = {}) => {
  const req = request(app).post(`/api/v1/queues/${queueId}/jobs`).set('Authorization', owner.auth);
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req.send(body);
};

const submitMany = async (n) => {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    ids.push((await submit({ name: `job-${i}` })).body.data.id);
  }
  return ids;
};

const newPublisher = ({ config, ...overrides } = {}) =>
  new OutboxPublisher({ redis, logger, config: { ...CONFIG, ...config }, ...overrides });

const streamEntries = async (queueId = queue.id) =>
  (await redis.xrange(jobStreamKey(queueId), '-', '+')).map(([id, fields]) => ({
    id,
    ...fromStreamFields(fields),
  }));

/** Ages PROCESSING claims as if their publisher died long ago. */
const ageClaims = () =>
  getDatabase().query(
    `UPDATE outbox_events SET locked_at = NOW() - INTERVAL '1 hour' WHERE status = 'PROCESSING'`
  );

describe('transactional outbox on job submission', () => {
  test('a WAITING job is committed together with one pending job.ready event', async () => {
    const res = await submit({ name: 'send', payload: { secret: 'not-in-event' } });
    assert.equal(res.status, 201);

    const events = await OutboxEvent.findAll();
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.status, 'PENDING');
    assert.equal(event.eventType, 'job.ready');
    assert.equal(event.aggregateType, 'job');
    assert.equal(event.aggregateId, res.body.data.id);
    assert.deepEqual(event.payload, { jobId: res.body.data.id, queueId: queue.id });
  });

  test('SCHEDULED jobs get no event yet (the scheduler emits it when due)', async () => {
    await submit({ name: 'later', delayMs: 60_000 });
    assert.equal(await OutboxEvent.count(), 0);
  });

  test('idempotent replays, including concurrent ones, produce a single event', async () => {
    const body = { name: 'x', idempotencyKey: 'k1' };
    await submit(body);
    await submit(body);
    await Promise.all(Array.from({ length: 8 }, () => submit({ name: 'y', idempotencyKey: 'k2' })));

    assert.equal(await Job.count(), 2);
    assert.equal(await OutboxEvent.count(), 2);
  });

  test('if the outbox insert fails, the job is rolled back too', async () => {
    mock.method(outboxRepository, 'createJobReady', async () => {
      throw new Error('simulated outbox failure');
    });

    const res = await submit({ name: 'x' });
    assert.equal(res.status, 500);
    assert.equal(await Job.count(), 0);
    assert.equal(await OutboxEvent.count(), 0);
  });
});

describe('outbox publisher', () => {
  test('publishes lightweight entries to the per-queue stream and marks events PUBLISHED', async () => {
    const queue2 = await createQueue(owner.auth, { name: 'sms' });
    const [jobId] = await submitMany(1);
    const job2 = (await submit({ name: 'sms-job', payload: { big: 'x'.repeat(1000) } }, { queueId: queue2.id }))
      .body.data.id;

    const result = await newPublisher().runOnce();
    assert.deepEqual(result, { claimed: 2, published: 2, failed: 0, lost: 0 });

    const [entry] = await streamEntries();
    assert.equal(entry.jobId, jobId);
    assert.equal(entry.queueId, queue.id);
    assert.equal(entry.eventType, 'job.ready');
    assert.equal(entry.payload, undefined, 'job payload must not be copied into the stream');
    assert.deepEqual((await streamEntries(queue2.id)).map((e) => e.jobId), [job2]);

    const event = await OutboxEvent.findOne({ where: { aggregateId: jobId } });
    assert.equal(event.status, 'PUBLISHED');
    assert.equal(event.streamId, entry.id);
    assert.equal(event.id, entry.eventId);
    assert.ok(event.publishedAt);
    assert.equal(event.lockedBy, null);

    // Nothing left to do on the next cycle.
    assert.equal((await newPublisher().runOnce()).claimed, 0);
  });

  test('while Redis is not ready, nothing is claimed and events stay pending', async () => {
    await submitMany(2);
    const offline = { status: 'reconnecting' };

    const result = await newPublisher({ redis: offline }).runOnce();
    assert.equal(result.skipped, true);

    const events = await OutboxEvent.findAll();
    assert.ok(events.every((e) => e.status === 'PENDING' && e.attempts === 0));
  });

  test('a failed XADD releases the event with backoff; it is published once Redis recovers', async () => {
    const [jobId] = await submitMany(1);
    const failing = {
      status: 'ready',
      xadd: async () => {
        throw new Error('Connection is closed.');
      },
    };

    const result = await newPublisher({ redis: failing }).runOnce();
    assert.deepEqual(result, { claimed: 1, published: 0, failed: 1, lost: 0 });

    const [[row]] = await getDatabase().query(
      `SELECT status, attempts, last_error, locked_by, next_attempt_at > NOW() AS deferred FROM outbox_events`
    );
    assert.equal(row.status, 'PENDING');
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, 'Connection is closed.');
    assert.equal(row.locked_by, null);
    assert.equal(row.deferred, true);

    // Not due yet: a healthy publisher leaves it alone.
    assert.equal((await newPublisher().runOnce()).claimed, 0);

    await getDatabase().query(`UPDATE outbox_events SET next_attempt_at = NOW()`);
    assert.equal((await newPublisher().runOnce()).published, 1);
    assert.deepEqual((await streamEntries()).map((e) => e.jobId), [jobId]);
    assert.equal((await OutboxEvent.findOne()).attempts, 2);
  });

  test('after a publisher crash, an expired claim is taken over; a fresh claim is not', async () => {
    await submitMany(2);
    // Simulate a publisher that claimed the batch and died before XADD.
    const claimed = await outboxRepository.claimBatch({ publisherId: 'dead', limit: 1, claimTimeoutMs: 30_000 });
    assert.equal(claimed.length, 1);

    // The fresh claim is respected; only the other event is published.
    let result = await newPublisher().runOnce();
    assert.equal(result.published, 1);

    await ageClaims();
    result = await newPublisher().runOnce();
    assert.equal(result.published, 1);
    assert.equal(await OutboxEvent.count({ where: { status: 'PUBLISHED' } }), 2);
    assert.equal((await streamEntries()).length, 2);
  });

  test('a crash between XADD and marking published yields a duplicate entry, never a lost one', async () => {
    const [jobId] = await submitMany(1);

    // Publisher A adds to the stream, then "crashes" before marking published.
    const crashing = newPublisher({
      publisherId: 'A',
      repository: {
        ...outboxRepository,
        markPublished: async () => {
          throw new Error('simulated crash');
        },
      },
    });
    await assert.rejects(crashing.runOnce(), /simulated crash/);
    assert.equal((await OutboxEvent.findOne()).status, 'PROCESSING');

    await ageClaims();
    const b = newPublisher({ publisherId: 'B' });
    assert.equal((await b.runOnce()).published, 1);

    const entries = await streamEntries();
    assert.equal(entries.length, 2, 'the event is delivered twice');
    assert.ok(entries.every((e) => e.jobId === jobId && e.eventId === entries[0].eventId));

    // If A comes back, its stale claim cannot overwrite B's result.
    const event = await OutboxEvent.findOne();
    const staleMark = await outboxRepository.markPublished({
      publisherId: 'A',
      published: [{ id: event.id, streamId: '0-1' }],
    });
    assert.deepEqual(staleMark, []);
    assert.equal((await OutboxEvent.findOne()).streamId, entries[1].id);
  });

  test('concurrent publishers each publish an event exactly once', async () => {
    const jobIds = await submitMany(60);
    const publishers = Array.from({ length: 3 }, (_, i) =>
      newPublisher({ publisherId: `p${i}`, config: { batchSize: 7 } })
    );

    let rounds = 0;
    let claimed;
    do {
      const results = await Promise.all(publishers.map((p) => p.runOnce()));
      claimed = results.reduce((sum, r) => sum + r.claimed, 0);
      rounds += 1;
    } while (claimed > 0 && rounds < 50);

    const entries = await streamEntries();
    assert.equal(entries.length, 60);
    assert.deepEqual(new Set(entries.map((e) => e.jobId)), new Set(jobIds));
    assert.equal(await OutboxEvent.count({ where: { status: 'PUBLISHED' } }), 60);
  });

  test('the polling loop publishes new events and stops cleanly', async () => {
    const publisher = newPublisher();
    publisher.start();
    try {
      const [jobId] = await submitMany(1);
      const deadline = Date.now() + 5000;
      while ((await OutboxEvent.count({ where: { status: 'PUBLISHED' } })) === 0) {
        assert.ok(Date.now() < deadline, 'event was not published within 5s');
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.deepEqual((await streamEntries()).map((e) => e.jobId), [jobId]);
    } finally {
      await publisher.stop();
    }
    assert.equal(publisher.running, false);
  });
});
