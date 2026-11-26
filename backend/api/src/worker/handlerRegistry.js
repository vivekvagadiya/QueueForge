/**
 * Maps job names to handlers.
 *
 * Handler contract:
 *   async (ctx) => result
 *   ctx.job     { id, queueId, name, payload, attempt, maxAttempts }
 *   ctx.signal  AbortSignal, aborted when the worker must stop; long handlers
 *               should check it and stop early
 *   ctx.logger  pino logger bound to the job
 *
 * - The returned value must be JSON-serializable; it is stored as the job result.
 * - Throw to fail the attempt. Throw NonRetryableError to skip retries.
 * - Delivery is at-least-once: a handler can run more than once for the same
 *   job (e.g. a crash after a side effect but before the result is saved), so
 *   handlers must be idempotent. Use ctx.job.id as an idempotency key with
 *   external providers where possible.
 */
export class HandlerRegistry {
  constructor() {
    this.handlers = new Map();
  }

  register(name, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError(`Handler for "${name}" must be a function`);
    }
    if (this.handlers.has(name)) {
      throw new Error(`A handler for "${name}" is already registered`);
    }
    this.handlers.set(name, handler);
    return this;
  }

  get(name) {
    return this.handlers.get(name);
  }

  names() {
    return [...this.handlers.keys()];
  }
}
