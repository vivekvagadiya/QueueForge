import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env.js';
import apiRoutes from './routes/index.js';
import { enterRequestContext, requestContext } from './middlewares/requestContext.js';
import { notFoundHandler } from './middlewares/notFound.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { renderMetrics } from './observability/metrics.js';
import { isMetricsAuthorized } from './observability/opsServer.js';

const app = express();

app.disable('x-powered-by');

// First, so every later log line (including errors) carries the request's correlation ID.
app.use(requestContext);
app.use(helmet());
app.use(
  cors({
    origin: env.corsOrigin,
    credentials: env.corsOrigin !== '*',
    exposedHeaders: ['X-Request-Id'],
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(enterRequestContext);

// Prometheus scrape endpoint for this API instance, plus the cluster gauges
// computed from PostgreSQL (registered in server.js). Not under /api/v1: it is
// for monitoring, not for the dashboard. Protect it with METRICS_TOKEN or keep
// it off public networks.
app.get('/metrics', async (req, res, next) => {
  try {
    if (!isMetricsAuthorized(req.get('authorization'))) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid metrics token' } });
    }
    const { contentType, body } = await renderMetrics();
    return res.set('Content-Type', contentType).set('Cache-Control', 'no-store').send(body);
  } catch (err) {
    return next(err);
  }
});

app.use('/api/v1', apiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
