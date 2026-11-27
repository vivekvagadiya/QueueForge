import crypto from 'node:crypto';
import http from 'node:http';
import { env } from '../config/env.js';
import { livenessBody } from './health.js';
import { renderMetrics } from './metrics.js';

/** True when /metrics may be served: no METRICS_TOKEN set, or the bearer token matches. */
export const isMetricsAuthorized = (authorizationHeader, token = env.METRICS_TOKEN) => {
  if (!token) return true;
  const [scheme, value] = String(authorizationHeader ?? '').split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return false;
  const a = crypto.createHash('sha256').update(value).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
};

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

/**
 * Minimal HTTP server for processes that have no API: the publisher, workers
 * and recovery. Serves
 *   GET /health/live   200 while the process runs
 *   GET /health/ready  200 when ready, 503 otherwise (body lists each check)
 *   GET /metrics       Prometheus text format
 * Started only when OPS_PORT is set; give each process on a host its own port.
 */
export const startOpsServer = async ({ port = env.OPS_PORT, host = env.OPS_HOST, readiness, logger }) => {
  if (!port) return null;

  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    }
    try {
      if (path === '/health/live') return sendJson(res, 200, livenessBody());
      if (path === '/health/ready') {
        const { ready, body } = await readiness.check();
        return sendJson(res, ready ? 200 : 503, body);
      }
      if (path === '/metrics') {
        if (!isMetricsAuthorized(req.headers.authorization)) return sendJson(res, 401, { error: 'UNAUTHORIZED' });
        const { contentType, body } = await renderMetrics();
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
        return res.end(body);
      }
      return sendJson(res, 404, { error: 'NOT_FOUND' });
    } catch (err) {
      logger.error({ err, path }, 'Ops endpoint failed');
      return sendJson(res, 500, { error: 'INTERNAL_ERROR' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info({ port, host }, 'Ops server listening (/health/live, /health/ready, /metrics)');

  return {
    server,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};
