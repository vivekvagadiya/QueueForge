import { Sequelize } from 'sequelize';
import request from 'supertest';
import app from '../src/app.js';
import { closeDatabase, getDatabase } from '../src/config/database.js';
import { createRedisClient } from '../src/config/redis.js';
import { createMigrator } from '../src/database/umzug.js';
import { initModels } from '../src/models/index.js';

export { app, request };

const TABLES = ['outbox_events', 'job_attempts', 'jobs', 'workers', 'queues', 'users'];

/** Real Redis client for tests; resolves once connected. */
export const connectTestRedis = async () => {
  const client = createRedisClient('test');
  if (client.status !== 'ready') {
    await new Promise((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
    });
  }
  return client;
};

/** Deletes all streams under the test prefix (never touches dev keys). */
export const clearTestStreams = async (client) => {
  const prefix = process.env.STREAM_PREFIX;
  if (!prefix.endsWith('-test')) throw new Error(`Refusing to clear non-test prefix ${prefix}`);
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500);
    if (keys.length) await client.del(...keys);
    cursor = next;
  } while (cursor !== '0');
};

/** Creates the test database if it does not exist yet. */
const ensureTestDatabase = async () => {
  const url = new URL(process.env.DATABASE_URL);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';

  const admin = new Sequelize(url.toString(), { dialect: 'postgres', logging: false });
  try {
    const [rows] = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', {
      bind: [dbName],
    });
    if (rows.length === 0) {
      await admin.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.close();
  }
};

/** Call in `before()`: ensures DB exists, applies migrations, registers models, clears data. */
export const setupDatabase = async () => {
  await ensureTestDatabase();
  const sequelize = getDatabase();
  await createMigrator(sequelize).up();
  initModels(sequelize);
  await resetDatabase();
};

export const resetDatabase = () =>
  getDatabase().query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);

export const teardownDatabase = () => closeDatabase();

let userCounter = 0;

/** Registers a fresh user and returns `{ user, token, auth }` where `auth` is the header value. */
export const createUser = async (overrides = {}) => {
  userCounter += 1;
  const body = {
    name: `User ${userCounter}`,
    email: `user${userCounter}-${Date.now()}@example.com`,
    password: 'correct-horse-battery',
    ...overrides,
  };
  const res = await request(app).post('/api/v1/auth/register').send(body);
  if (res.status !== 201) {
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const token = res.body.data.accessToken;
  return { user: res.body.data.user, token, auth: `Bearer ${token}`, password: body.password };
};

export const createQueue = async (auth, body = {}) => {
  const res = await request(app)
    .post('/api/v1/queues')
    .set('Authorization', auth)
    .send({ name: `queue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...body });
  if (res.status !== 201) {
    throw new Error(`create queue failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data;
};
