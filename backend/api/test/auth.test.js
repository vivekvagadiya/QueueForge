import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { app, createUser, request, setupDatabase, teardownDatabase } from './helpers.js';

before(setupDatabase);
after(teardownDatabase);

describe('POST /auth/register', () => {
  test('creates a user and returns a token without exposing the password hash', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Ada', email: '  Ada@Example.COM ', password: 'correct-horse-battery' });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.user.email, 'ada@example.com');
    assert.equal(res.body.data.tokenType, 'Bearer');
    assert.ok(res.body.data.accessToken);
    assert.equal(JSON.stringify(res.body).includes('password'), false);
  });

  test('rejects a duplicate email regardless of case', async () => {
    await createUser({ email: 'dup@example.com' });
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Dup', email: 'DUP@example.com', password: 'correct-horse-battery' });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'EMAIL_TAKEN');
  });

  test('returns a consistent validation error shape', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: '', email: 'not-an-email', password: 'short', extra: true });

    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    const paths = res.body.error.details.map((d) => d.path);
    for (const field of ['name', 'email', 'password']) {
      assert.ok(paths.includes(field), `expected an error for ${field}`);
    }
    assert.ok(res.body.error.details.some((d) => d.message.includes('extra')));
  });

  test('rejects malformed JSON', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('Content-Type', 'application/json')
      .send('{"name":');

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_JSON');
  });
});

describe('POST /auth/login', () => {
  test('returns a token for valid credentials', async () => {
    const { user, password } = await createUser();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email.toUpperCase(), password });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.id, user.id);
    assert.ok(res.body.data.accessToken);
  });

  test('gives the same 401 for a wrong password and an unknown email', async () => {
    const { user } = await createUser();
    const wrong = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'wrong-password' });
    const unknown = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong-password' });

    for (const res of [wrong, unknown]) {
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
    }
    assert.equal(wrong.body.error.message, unknown.body.error.message);
  });
});

describe('GET /auth/me', () => {
  test('returns the current user for a valid token', async () => {
    const { user, auth } = await createUser();
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', auth);

    assert.equal(res.status, 200);
    assert.equal(res.body.data.id, user.id);
  });

  test('rejects missing, malformed, forged, and expired tokens', async () => {
    const { user } = await createUser();
    const secret = process.env.JWT_SECRET;
    const forged = jwt.sign({}, 'some-other-secret-that-is-long-enough!!', {
      subject: user.id,
      issuer: 'queueforge-api',
    });
    const expired = jwt.sign({}, secret, {
      subject: user.id,
      issuer: 'queueforge-api',
      expiresIn: -10,
    });
    const unsigned = jwt.sign({}, null, { algorithm: 'none', subject: user.id });

    const cases = [
      [undefined, 'UNAUTHORIZED'],
      ['Basic abc', 'UNAUTHORIZED'],
      ['Bearer not-a-jwt', 'INVALID_TOKEN'],
      [`Bearer ${forged}`, 'INVALID_TOKEN'],
      [`Bearer ${unsigned}`, 'INVALID_TOKEN'],
      [`Bearer ${expired}`, 'TOKEN_EXPIRED'],
    ];

    for (const [header, code] of cases) {
      const req = request(app).get('/api/v1/auth/me');
      if (header) req.set('Authorization', header);
      const res = await req;
      assert.equal(res.status, 401, `header ${header}`);
      assert.equal(res.body.error.code, code, `header ${header}`);
    }
  });
});
