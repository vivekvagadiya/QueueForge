/**
 * Errors handlers can throw to control what happens to the job.
 * Any other thrown error is treated as retryable.
 */
export class JobError extends Error {
  constructor(message, { code = 'JOB_ERROR', retryable = true, cause } = {}) {
    super(message, { cause });
    this.name = 'JobError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** The job can never succeed (bad payload, permanent rejection): fail without retrying. */
export class NonRetryableError extends JobError {
  constructor(message, { code = 'NON_RETRYABLE', cause } = {}) {
    super(message, { code, retryable: false, cause });
    this.name = 'NonRetryableError';
  }
}

export const isRetryable = (err) => err?.retryable !== false;

export const errorCode = (err) =>
  err?.code && typeof err.code === 'string' ? err.code.slice(0, 100) : err?.name ?? 'Error';
