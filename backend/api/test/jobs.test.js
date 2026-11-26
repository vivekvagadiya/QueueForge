import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Job } from '../src/models/index.js';
import {
  app,
  createQueue,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  teardownDatabase,
} from './helpers.js';

before(setupDatabase);
after(teardownDatabase);

let owner;
let other;
let queue;

beforeEach(async () => {
  await resetDatabase();
  owner = await createUser();
  other = await createUser();
  queue = await createQueue(owner.auth, {
    name: 'emails',
    defaultJobOptions: { maxAttempts: 5, priority: 10 },
  });
});

const submit = (body, { auth = owner.auth, queueId = queue.id, headers = {} } = {}) => {
  const req = request(app).post(`/api/v1/queues/${queueId}/jobs`).set('Authorization', auth);
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req.send(body);
};

describe('job submission', () => {
  test('creates a WAITING job using queue default options', async () => {
    const res = await submit({ name: 'send-welcome', payload: { to: 'a@example.com' } });

    assert.equal(res.status, 201);
    const job = res.body.data;
    assert.equal(job.status, 'WAITING');
    assert.equal(job.queueId, queue.id);
    assert.equal(job.maxAttempts, 5);
    assert.equal(job.priority, 10);
    assert.equal(job.attemptsMade, 0);
    assert.equal(job.scheduledAt, null);
    assert.deepEqual(job.payload, { to: 'a@example.com' });
    // Lease internals are not part of the public API.
    assert.equal(job.lockedBy, undefined);
    assert.equal(job.leaseVersion, undefined);
  });

  test('request options override queue defaults', async () => {
    const res = await submit({ name: 'x', maxAttempts: 1, priority: -3 });
    assert.equal(res.body.data.maxAttempts, 1);
    assert.equal(res.body.data.priority, -3);
  });

  test('delayMs and future scheduledAt create SCHEDULED jobs; past scheduledAt is WAITING', async () => {
    const before = Date.now();
    const delayed = await submit({ name: 'later', delayMs: 60_000 });
    assert.equal(delayed.body.data.status, 'SCHEDULED');
    const runAt = new Date(delayed.body.data.scheduledAt).getTime();
    assert.ok(runAt >= before + 60_000 && runAt <= Date.now() + 60_000);

    const future = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await submit({ name: 'at', scheduledAt: future });
    assert.equal(scheduled.body.data.status, 'SCHEDULED');
    assert.equal(scheduled.body.data.scheduledAt, future);

    const past = await submit({ name: 'past', scheduledAt: '2020-01-01T00:00:00Z' });
    assert.equal(past.body.data.status, 'WAITING');
    assert.equal(past.body.data.scheduledAt, null);
  });

  test('validates input', async () => {
    const cases = [
      {},
      { name: 'x', payload: [1, 2] },
      { name: 'x', payload: 'str' },
      { name: 'x', delayMs: 10, scheduledAt: new Date().toISOString() },
      { name: 'x', scheduledAt: 'tomorrow' },
      { name: 'x', maxAttempts: 0 },
      { name: 'x', status: 'COMPLETED' },
    ];
    for (const body of cases) {
      const res = await submit(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    }
    assert.equal(await Job.count(), 0);
  });

  test('cannot submit to a queue the caller does not own', async () => {
    const res = await submit({ name: 'x' }, { auth: other.auth });
    assert.equal(res.status, 404);
    assert.equal(await Job.count(), 0);
  });

  test('archived queues reject jobs; paused queues still accept them', async () => {
    await request(app)
      .patch(`/api/v1/queues/${queue.id}`)
      .set('Authorization', owner.auth)
      .send({ status: 'PAUSED' });
    assert.equal((await submit({ name: 'x' })).status, 201);

    await request(app)
      .patch(`/api/v1/queues/${queue.id}`)
      .set('Authorization', owner.auth)
      .send({ status: 'ARCHIVED' });
    const res = await submit({ name: 'y' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'QUEUE_ARCHIVED');
  });
});

describe('idempotency', () => {
  test('replaying a key returns the original job instead of creating another', async () => {
    const body = { name: 'charge', payload: { amount: 100, currency: 'USD' }, idempotencyKey: 'order-1' };
    const first = await submit(body);
    // Same payload with different key order is the same logical request.
    const replay = await submit({ ...body, payload: { currency: 'USD', amount: 100 } });

    assert.equal(first.status, 201);
    assert.equal(first.headers['idempotent-replayed'], 'false');
    assert.equal(replay.status, 200);
    assert.equal(replay.headers['idempotent-replayed'], 'true');
    assert.equal(replay.body.data.id, first.body.data.id);
    assert.equal(await Job.count(), 1);
  });

  test('accepts the key via the Idempotency-Key header', async () => {
    const a = await submit({ name: 'x' }, { headers: { 'Idempotency-Key': 'hdr-1' } });
    const b = await submit({ name: 'x' }, { headers: { 'Idempotency-Key': 'hdr-1' } });
    assert.equal(a.body.data.idempotencyKey, 'hdr-1');
    assert.equal(b.body.data.id, a.body.data.id);
    assert.equal(await Job.count(), 1);
  });

  test('header and body keys must match', async () => {
    const res = await submit(
      { name: 'x', idempotencyKey: 'body-key' },
      { headers: { 'Idempotency-Key': 'header-key' } }
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'IDEMPOTENCY_KEY_MISMATCH');
  });

  test('reusing a key for a different job is a conflict', async () => {
    const first = await submit({ name: 'charge', payload: { amount: 100 }, idempotencyKey: 'k' });
    const res = await submit({ name: 'charge', payload: { amount: 999 }, idempotencyKey: 'k' });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'IDEMPOTENCY_KEY_CONFLICT');
    assert.equal(res.body.error.details.jobId, first.body.data.id);
    assert.equal(await Job.count(), 1);
  });

  test('keys are scoped per queue', async () => {
    const queue2 = await createQueue(owner.auth, { name: 'sms' });
    await submit({ name: 'x', idempotencyKey: 'same' });
    const res = await submit({ name: 'x', idempotencyKey: 'same' }, { queueId: queue2.id });
    assert.equal(res.status, 201);
    assert.equal(await Job.count(), 2);
  });

  test('concurrent submissions with the same key create exactly one job', async () => {
    const body = { name: 'race', payload: { n: 1 }, idempotencyKey: 'race-key' };
    const results = await Promise.all(Array.from({ length: 10 }, () => submit(body)));

    const statuses = results.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s === 201).length, 1);
    assert.equal(statuses.filter((s) => s === 200).length, 9);
    assert.equal(new Set(results.map((r) => r.body.data.id)).size, 1);
    assert.equal(await Job.count(), 1);
  });
});

describe('job retrieval', () => {
  test('lists jobs newest first with pagination and status filter', async () => {
    for (let i = 0; i < 4; i += 1) {
      await submit({ name: `now-${i}` });
    }
    await submit({ name: 'later', delayMs: 60_000 });

    const page = await request(app)
      .get(`/api/v1/queues/${queue.id}/jobs?limit=3`)
      .set('Authorization', owner.auth);
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.meta, { page: 1, limit: 3, total: 5, totalPages: 2 });
    assert.equal(page.body.data[0].name, 'later');

    const scheduled = await request(app)
      .get(`/api/v1/queues/${queue.id}/jobs?status=SCHEDULED`)
      .set('Authorization', owner.auth);
    assert.deepEqual(
      scheduled.body.data.map((j) => j.name),
      ['later']
    );

    const multi = await request(app)
      .get(`/api/v1/queues/${queue.id}/jobs?status=WAITING,SCHEDULED`)
      .set('Authorization', owner.auth);
    assert.equal(multi.body.meta.total, 5);
  });

  test('cannot list jobs of another user’s queue', async () => {
    await submit({ name: 'x' });
    const res = await request(app)
      .get(`/api/v1/queues/${queue.id}/jobs`)
      .set('Authorization', other.auth);
    assert.equal(res.status, 404);
  });

  test('gets a job with its attempt history; other users get 404', async () => {
    const created = await submit({ name: 'x' });
    const id = created.body.data.id;

    const mine = await request(app).get(`/api/v1/jobs/${id}`).set('Authorization', owner.auth);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.data.id, id);
    assert.deepEqual(mine.body.data.attempts, []);

    const theirs = await request(app).get(`/api/v1/jobs/${id}`).set('Authorization', other.auth);
    assert.equal(theirs.status, 404);
  });
});
