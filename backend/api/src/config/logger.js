import os from 'node:os';
import pino from 'pino';
import { env } from './env.js';
import { processRole } from './role.js';
import { getCorrelationId } from '../observability/context.js';

/**
 * Structured JSON logs. Every line carries the process role (api, publisher,
 * worker, recovery), pid and host, and the correlation ID of the unit of work
 * it was written in (see observability/context.js). Lines that pass their own
 * `correlationId` keep it.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: 'queueforge',
    role: processRole,
    env: env.NODE_ENV,
    pid: process.pid,
    hostname: os.hostname(),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin(mergeObject) {
    if (mergeObject.correlationId) return {};
    const correlationId = getCorrelationId();
    return correlationId ? { correlationId } : {};
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      'password',
      'token',
      '*.password',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
});
