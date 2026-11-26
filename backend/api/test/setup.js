/**
 * Preloaded via `node --import` before any test file, so it runs before
 * src/config/env.js reads process.env. dotenv never overrides variables that
 * are already set, so the values assigned here win over .env.
 */
import dotenv from 'dotenv';

dotenv.config();

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.JWT_SECRET ??= 'test-only-jwt-secret-with-at-least-32-characters';

const deriveTestUrl = (url) => {
  if (!url) {
    throw new Error('Set TEST_DATABASE_URL or DATABASE_URL to run integration tests');
  }
  const parsed = new URL(url);
  parsed.pathname = '/queueforge_test';
  return parsed.toString();
};

const testUrl = process.env.TEST_DATABASE_URL ?? deriveTestUrl(process.env.DATABASE_URL);
const dbName = new URL(testUrl).pathname.slice(1);

// Tests truncate tables; refuse to run against anything not clearly a test DB.
if (!dbName.endsWith('_test')) {
  throw new Error(`Refusing to run tests against database "${dbName}" (name must end in _test)`);
}

process.env.DATABASE_URL = testUrl;
