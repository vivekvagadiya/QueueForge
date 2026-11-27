import { getDatabase } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { isRedisReady } from '../config/redis.js';

/**
 * Liveness and readiness.
 *
 * - Liveness: the process is up and its event loop answers. It never checks
 *   dependencies, so an orchestrator does not restart every process while
 *   PostgreSQL or Redis is briefly down.
 * - Readiness: every *critical* dependency check passes and the process is not
 *   shutting down. Non-critical checks are reported (status "degraded") but
 *   don't fail readiness. Which checks are critical depends on the role: the
 *   API can serve without Redis, a worker can't.
 *
 * Responses expose only a short error code, never connection strings or
 * driver messages; the full error is logged when a check changes state.
 */
const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`Timed out after ${ms}ms`);
        err.code = 'TIMEOUT';
        reject(err);
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

const fail = (code, message = code) => {
  const err = new Error(message);
  err.code = code;
  throw err;
};

// --- Checks ----------------------------------------------------------------------

export const postgresCheck = ({ critical = true } = {}) => ({
  name: 'postgres',
  critical,
  run: async () => {
    await getDatabase().query('SELECT 1');
  },
});

/** PINGs a Redis client. Never use this on a connection that runs blocking reads. */
export const redisPingCheck = (client, { name = 'redis', critical = true } = {}) => ({
  name,
  critical,
  run: async () => {
    if (!client) fail('NOT_CONFIGURED');
    if (!isRedisReady(client)) fail('NOT_CONNECTED', `Redis connection is ${client.status}`);
    if ((await client.ping()) !== 'PONG') fail('UNEXPECTED_REPLY');
  },
});

/** Connection state only, for a client busy in a blocking command (worker reader). */
export const redisStatusCheck = (client, { name, critical = true }) => ({
  name,
  critical,
  run: async () => {
    if (!isRedisReady(client)) fail('NOT_CONNECTED', `Redis connection is ${client?.status ?? 'missing'}`);
  },
});

/** A check backed by a synchronous predicate (e.g. "the worker is RUNNING"). */
export const stateCheck = (name, isOk, { critical = true, code = 'NOT_READY' } = {}) => ({
  name,
  critical,
  run: async () => {
    if (!isOk()) fail(code);
  },
});

// --- Readiness ---------------------------------------------------------------------

/**
 * Builds a readiness probe over `checks`. Call `markShuttingDown()` when the
 * process starts stopping, so load balancers drain it before it exits.
 */
export const createReadiness = (checks, { timeoutMs = env.HEALTH_CHECK_TIMEOUT_MS, log = logger } = {}) => {
  let shuttingDown = false;
  const lastStatus = new Map();

  const runCheck = async (check) => {
    const started = Date.now();
    try {
      await withTimeout(Promise.resolve().then(check.run), timeoutMs);
      if (lastStatus.get(check.name) === 'down') log.info({ check: check.name }, 'Health check recovered');
      lastStatus.set(check.name, 'up');
      return { status: 'up', critical: check.critical, latencyMs: Date.now() - started };
    } catch (err) {
      if (lastStatus.get(check.name) !== 'down') {
        log.warn({ err, check: check.name, critical: check.critical }, 'Health check failed');
      }
      lastStatus.set(check.name, 'down');
      return {
        status: 'down',
        critical: check.critical,
        latencyMs: Date.now() - started,
        error: err.code ?? err.original?.code ?? 'ERROR',
      };
    }
  };

  return {
    markShuttingDown() {
      shuttingDown = true;
    },
    async check() {
      const results = await Promise.all(checks.map(runCheck));
      const byName = Object.fromEntries(checks.map((c, i) => [c.name, results[i]]));
      const criticalDown = results.some((r) => r.critical && r.status === 'down');
      const anyDown = results.some((r) => r.status === 'down');
      let status = 'ok';
      if (shuttingDown) status = 'shutting_down';
      else if (criticalDown) status = 'unavailable';
      else if (anyDown) status = 'degraded';
      return {
        ready: status === 'ok' || status === 'degraded',
        body: { status, checks: byName, timestamp: new Date().toISOString() },
      };
    },
  };
};

export const livenessBody = () => ({
  status: 'ok',
  uptimeSeconds: Math.round(process.uptime()),
  timestamp: new Date().toISOString(),
});
