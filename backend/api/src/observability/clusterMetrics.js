import { logger } from '../config/logger.js';
import { metricsRepository } from '../repositories/metrics.repository.js';
import { promClient, registry } from './metrics.js';

const BACKLOG_STATUSES = ['SCHEDULED', 'WAITING', 'ACTIVE', 'RETRYING'];
// Workers that are expected to take work; STOPPED / UNHEALTHY capacity is not counted.
const SERVING_WORKER_STATUSES = new Set(['STARTING', 'RUNNING', 'DRAINING']);

/**
 * Cluster gauges computed from PostgreSQL when /metrics is scraped (API only).
 * One snapshot (four aggregate queries) is shared by every gauge in a scrape
 * and reused for `cacheMs`, so several scrapers or API instances don't
 * multiply the load. If the snapshot fails, these gauges are omitted and
 * queueforge_cluster_metrics_up is 0; process metrics are still served.
 */
export const registerClusterMetrics = ({ cacheMs = 5000, repository = metricsRepository } = {}) => {
  let cached = null; // { at, promise }

  const snapshot = () => {
    const now = Date.now();
    if (!cached || now - cached.at >= cacheMs) {
      const promise = repository.snapshot().catch((err) => {
        logger.warn({ err }, 'Cluster metrics snapshot failed');
        return null;
      });
      cached = { at: now, promise };
    }
    return cached.promise;
  };

  const gauge = (name, help, labelNames, fill) =>
    new promClient.Gauge({
      name,
      help,
      labelNames,
      registers: [registry],
      async collect() {
        this.reset();
        const snap = await snapshot();
        if (snap) fill(this, snap);
      },
    });

  new promClient.Gauge({
    name: 'queueforge_cluster_metrics_up',
    help: 'Whether the cluster metrics snapshot (PostgreSQL) succeeded',
    registers: [registry],
    async collect() {
      this.set((await snapshot()) ? 1 : 0);
    },
  });

  gauge(
    'queueforge_queue_jobs',
    'Jobs per queue in a non-terminal status (queue depth = status="WAITING")',
    ['queue_id', 'status'],
    (g, { queueIds, jobs }) => {
      for (const queueId of queueIds) {
        for (const status of BACKLOG_STATUSES) g.set({ queue_id: queueId, status }, 0);
      }
      for (const row of jobs) g.set({ queue_id: row.queue_id, status: row.status }, row.count);
    }
  );

  gauge(
    'queueforge_queue_oldest_waiting_age_seconds',
    'Age of the oldest WAITING job per queue (0 when none are waiting)',
    ['queue_id'],
    (g, { queueIds, jobs }) => {
      for (const queueId of queueIds) g.set({ queue_id: queueId }, 0);
      for (const row of jobs) {
        if (row.status === 'WAITING') g.set({ queue_id: row.queue_id }, Math.max(0, row.oldest_age_seconds));
      }
    }
  );

  gauge('queueforge_workers', 'Registered workers by status', ['status'], (g, { workers }) => {
    for (const row of workers) g.set({ status: row.status }, row.count);
  });

  const serving = (workers) => workers.filter((w) => SERVING_WORKER_STATUSES.has(w.status));
  gauge(
    'queueforge_cluster_worker_active_jobs',
    'Jobs running on serving workers, as last reported by their heartbeats',
    [],
    (g, { workers }) => g.set(serving(workers).reduce((sum, w) => sum + w.active_jobs, 0))
  );
  gauge('queueforge_cluster_worker_capacity', 'Total concurrency of serving workers', [], (g, { workers }) =>
    g.set(serving(workers).reduce((sum, w) => sum + w.concurrency, 0))
  );
  gauge(
    'queueforge_cluster_worker_utilization_ratio',
    'Active jobs divided by capacity across serving workers (0 when there is no capacity)',
    [],
    (g, { workers }) => {
      const list = serving(workers);
      const capacity = list.reduce((sum, w) => sum + w.concurrency, 0);
      const active = list.reduce((sum, w) => sum + w.active_jobs, 0);
      g.set(capacity > 0 ? active / capacity : 0);
    }
  );

  gauge('queueforge_outbox_events', 'Outbox events not yet published, by status', ['status'], (g, { outbox }) => {
    g.set({ status: 'PENDING' }, outbox.pending);
    g.set({ status: 'PROCESSING' }, outbox.processing);
  });
  gauge(
    'queueforge_outbox_oldest_unpublished_age_seconds',
    'Age of the oldest unpublished outbox event: publisher lag as seen from PostgreSQL',
    [],
    (g, { outbox }) => g.set(outbox.oldestUnpublishedAgeMs / 1000)
  );
};
