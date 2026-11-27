import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  app,
  createQueue,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  teardownDatabase,
} from './helpers.js';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

before(setupDatabase);
after(teardownDatabase);

let owner;
let other;

beforeEach(async () => {
  await resetDatabase();
  owner = await createUser();
  other = await createUser();
});

describe('queue CRUD', () => {
  test('creates a queue with defaults', async () => {
    const res = await request(app)
      .post('/api/v1/queues')
      .set('Authorization', owner.auth)
      .send({ name: 'emails', description: 'Transactional email' });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.name, 'emails');
    assert.equal(res.body.data.status, 'ACTIVE');
    assert.equal(res.body.data.concurrency, 1);
    assert.deepEqual(res.body.data.defaultJobOptions, {});
    assert.equal(res.body.data.userId, undefined);
  });

  test('rejects a duplicate name for the same user but allows it for another user', async () => {
    await createQueue(owner.auth, { name: 'emails' });

    const dup = await request(app)
      .post('/api/v1/queues')
      .set('Authorization', owner.auth)
      .send({ name: 'emails' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'QUEUE_NAME_TAKEN');

    const otherUser = await request(app)
      .post('/api/v1/queues')
      .set('Authorization', other.auth)
      .send({ name: 'emails' });
    assert.equal(otherUser.status, 201);
  });

  test('validates name, concurrency, and unknown fields', async () => {
    const res = await request(app)
      .post('/api/v1/queues')
      .set('Authorization', owner.auth)
      .send({ name: 'bad name!', concurrency: 0, defaultJobOptions: { maxAttempts: 0 }, foo: 1 });

    assert.equal(res.status, 400);
    const paths = res.body.error.details.map((d) => d.path);
    assert.ok(paths.includes('name'));
    assert.ok(paths.includes('concurrency'));
    assert.ok(paths.includes('defaultJobOptions.maxAttempts'));
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/api/v1/queues');
    assert.equal(res.status, 401);
  });

  test('lists only the caller’s queues with pagination and status filter', async () => {
    for (let i = 0; i < 5; i += 1) {
      await createQueue(owner.auth, { name: `q${i}` });
    }
    const paused = await createQueue(owner.auth, { name: 'paused-q' });
    await request(app)
      .patch(`/api/v1/queues/${paused.id}`)
      .set('Authorization', owner.auth)
      .send({ status: 'PAUSED' });
    await createQueue(other.auth, { name: 'not-mine' });

    const page1 = await request(app)
      .get('/api/v1/queues?limit=4&page=1')
      .set('Authorization', owner.auth);
    assert.equal(page1.status, 200);
    assert.equal(page1.body.data.length, 4);
    assert.deepEqual(page1.body.meta, { page: 1, limit: 4, total: 6, totalPages: 2 });

    const page2 = await request(app)
      .get('/api/v1/queues?limit=4&page=2')
      .set('Authorization', owner.auth);
    assert.equal(page2.body.data.length, 2);
    const allNames = [...page1.body.data, ...page2.body.data].map((q) => q.name);
    assert.equal(new Set(allNames).size, 6);
    assert.ok(!allNames.includes('not-mine'));

    const filtered = await request(app)
      .get('/api/v1/queues?status=paused')
      .set('Authorization', owner.auth);
    assert.deepEqual(
      filtered.body.data.map((q) => q.name),
      ['paused-q']
    );

    const badFilter = await request(app)
      .get('/api/v1/queues?status=BOGUS&limit=500')
      .set('Authorization', owner.auth);
    assert.equal(badFilter.status, 400);
  });

  test('searches queue names case-insensitively, treating wildcards literally', async () => {
    const created = {};
    for (const name of ['Email-Send', 'email_digest', 'sms', 'emailXdigest']) {
      created[name] = await createQueue(owner.auth, { name });
    }
    await createQueue(other.auth, { name: 'email-other' });
    const names = async (qs) =>
      (await request(app).get(`/api/v1/queues?${qs}`).set('Authorization', owner.auth)).body.data
        .map((q) => q.name)
        .sort();

    assert.deepEqual(await names('search=EMAIL'), ['Email-Send', 'emailXdigest', 'email_digest']);
    assert.deepEqual(await names('search=email_'), ['email_digest'], '_ is not a wildcard');
    assert.deepEqual(await names('search=%25'), [], '% is not a wildcard');
    assert.deepEqual(await names('search='), ['Email-Send', 'emailXdigest', 'email_digest', 'sms']);

    await request(app).post(`/api/v1/queues/${created.sms.id}/pause`).set('Authorization', owner.auth);
    assert.deepEqual(await names('search=s&status=PAUSED'), ['sms'], 'combines with the status filter');
  });

  test('gets and updates an owned queue', async () => {
    const queue = await createQueue(owner.auth, { name: 'reports' });

    const got = await request(app).get(`/api/v1/queues/${queue.id}`).set('Authorization', owner.auth);
    assert.equal(got.status, 200);
    assert.equal(got.body.data.id, queue.id);

    const updated = await request(app)
      .patch(`/api/v1/queues/${queue.id}`)
      .set('Authorization', owner.auth)
      .send({ concurrency: 5, status: 'PAUSED', defaultJobOptions: { maxAttempts: 7 } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.concurrency, 5);
    assert.equal(updated.body.data.status, 'PAUSED');
    assert.deepEqual(updated.body.data.defaultJobOptions, { maxAttempts: 7 });

    const empty = await request(app)
      .patch(`/api/v1/queues/${queue.id}`)
      .set('Authorization', owner.auth)
      .send({});
    assert.equal(empty.status, 400);
  });

  test('rename to an existing name conflicts', async () => {
    await createQueue(owner.auth, { name: 'a' });
    const b = await createQueue(owner.auth, { name: 'b' });

    const res = await request(app)
      .patch(`/api/v1/queues/${b.id}`)
      .set('Authorization', owner.auth)
      .send({ name: 'a' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'QUEUE_NAME_TAKEN');
  });

  test('another user’s queue is indistinguishable from a missing one', async () => {
    const queue = await createQueue(owner.auth);

    for (const id of [queue.id, MISSING_ID]) {
      const get = await request(app).get(`/api/v1/queues/${id}`).set('Authorization', other.auth);
      assert.equal(get.status, 404);
      assert.equal(get.body.error.code, 'NOT_FOUND');

      const patch = await request(app)
        .patch(`/api/v1/queues/${id}`)
        .set('Authorization', other.auth)
        .send({ status: 'PAUSED' });
      assert.equal(patch.status, 404);
    }

    const stillActive = await request(app)
      .get(`/api/v1/queues/${queue.id}`)
      .set('Authorization', owner.auth);
    assert.equal(stillActive.body.data.status, 'ACTIVE');
  });

  test('rejects a non-UUID queue id', async () => {
    const res = await request(app).get('/api/v1/queues/not-a-uuid').set('Authorization', owner.auth);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });
});
