import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

/**
 * Correlation context for logs. Each unit of work (an HTTP request, a worker
 * stream entry, a publisher cycle, a recovery pass) runs inside a context
 * with a correlation ID; the logger adds it to every line written inside,
 * including lines from repositories, handlers and timers started there.
 *
 * The ID follows a job across processes: the API stores the request's ID on
 * the outbox event, the publisher copies it into the stream entry, and the
 * worker runs the entry under it. Jobs released by the recovery process carry
 * the ID of the recovery pass that released them.
 */
const storage = new AsyncLocalStorage();

/** Accepted for caller-supplied IDs (X-Request-Id); anything else is replaced. */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export const newCorrelationId = () => crypto.randomUUID();

export const isValidCorrelationId = (value) =>
  typeof value === 'string' && CORRELATION_ID_PATTERN.test(value);

export const getCorrelationId = () => storage.getStore()?.correlationId ?? null;

/** Runs `fn` with the given correlation ID (a fresh one if missing or invalid). */
export const withCorrelationId = (correlationId, fn) =>
  storage.run(
    { correlationId: isValidCorrelationId(correlationId) ? correlationId : newCorrelationId() },
    fn
  );
