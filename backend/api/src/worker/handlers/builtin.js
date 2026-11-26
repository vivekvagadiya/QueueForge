import { setTimeout as delay } from 'node:timers/promises';
import { JobError, NonRetryableError } from '../errors.js';

/**
 * Built-in handlers for smoke tests and demos. Real workloads register their
 * own handlers in src/worker/handlers/index.js.
 */
export const builtinHandlers = {
  /** Returns the payload unchanged. */
  'system.echo': async ({ job }) => ({ echoed: job.payload }),

  /** Waits payload.ms milliseconds (default 1000); stops early if the worker aborts. */
  'system.sleep': async ({ job, signal }) => {
    const ms = Number(job.payload.ms ?? 1000);
    if (!Number.isFinite(ms) || ms < 0 || ms > 3_600_000) {
      throw new NonRetryableError('payload.ms must be between 0 and 3600000', { code: 'INVALID_PAYLOAD' });
    }
    await delay(ms, undefined, { signal });
    return { sleptMs: ms };
  },

  /** Always fails; payload.retryable=false makes the failure permanent. */
  'system.fail': async ({ job }) => {
    throw new JobError(job.payload.message ?? 'Intentional failure', {
      code: 'INTENTIONAL_FAILURE',
      retryable: job.payload.retryable !== false,
    });
  },
};
