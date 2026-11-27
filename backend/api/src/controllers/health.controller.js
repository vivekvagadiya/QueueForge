import { env } from '../config/env.js';
import { createReadiness, livenessBody, postgresCheck } from '../observability/health.js';

/**
 * The API's readiness checks. Until server.js configures the full set
 * (PostgreSQL critical; Redis and the realtime listener reported only, since
 * the API serves requests without them), PostgreSQL alone is checked.
 */
let readiness = createReadiness([postgresCheck()]);

export const configureApiReadiness = (checks) => {
  readiness = createReadiness(checks);
  return readiness;
};

/** Kept for compatibility: a liveness response with service details. */
export const getHealth = (_req, res) => {
  res.status(200).json({
    success: true,
    data: {
      status: 'ok',
      service: 'queueforge-api',
      environment: env.NODE_ENV,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
  });
};

export const getLiveness = (_req, res) => {
  res.set('Cache-Control', 'no-store').status(200).json({ success: true, data: livenessBody() });
};

export const getReadiness = async (_req, res, next) => {
  try {
    const { ready, body } = await readiness.check();
    res.set('Cache-Control', 'no-store').status(ready ? 200 : 503).json({ success: ready, data: body });
  } catch (err) {
    next(err);
  }
};
