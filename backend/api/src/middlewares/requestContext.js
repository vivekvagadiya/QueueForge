import { logger } from '../config/logger.js';
import { isValidCorrelationId, newCorrelationId, withCorrelationId } from '../observability/context.js';
import { httpRequestDuration } from '../observability/metrics.js';

// Probe and scrape traffic is logged at debug so it doesn't drown real requests.
const QUIET_PATHS = /^\/(?:api\/v1\/health(?:\/|$)|metrics$)/;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Route label for metrics: the path with ID segments replaced by ":id", for
 * requests that matched a route. Unmatched paths (404s, scanners) share one
 * label so they can't create unbounded series.
 */
const routeLabel = (req, path) =>
  req.route
    ? path
        .split('/')
        .map((segment) => (UUID_SEGMENT.test(segment) ? ':id' : segment))
        .join('/')
    : 'unmatched';

/**
 * Gives each request a correlation ID: the caller's `X-Request-Id` when it is
 * well formed, otherwise a new UUID. The ID is echoed in the response header
 * and error bodies, attached to every log line written while handling the
 * request, and stored on outbox events the request creates, so the job's
 * publisher and worker logs share it.
 *
 * Also writes one structured access-log line and records request duration.
 */
export const requestContext = (req, res, next) => {
  const incoming = req.get('x-request-id');
  const requestId = isValidCorrelationId(incoming) ? incoming : newCorrelationId();
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    const path = req.originalUrl.split('?')[0];
    const route = routeLabel(req, path);
    httpRequestDuration.observe({ method: req.method, route, status_code: res.statusCode }, seconds);

    const fields = {
      correlationId: requestId,
      method: req.method,
      path,
      route,
      statusCode: res.statusCode,
      durationMs: Math.round(seconds * 1000),
      userId: req.user?.id,
    };
    if (res.statusCode >= 500) logger.warn(fields, 'Request failed');
    else if (QUIET_PATHS.test(path)) logger.debug(fields, 'Request completed');
    else logger.info(fields, 'Request completed');
  });

  withCorrelationId(requestId, next);
};

/**
 * Re-enters the request's correlation context. Mount after the body parsers:
 * they resume `next` from stream callbacks, which don't carry the context.
 */
export const enterRequestContext = (req, _res, next) => withCorrelationId(req.id, next);
