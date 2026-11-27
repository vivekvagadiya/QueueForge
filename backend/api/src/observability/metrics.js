import client from 'prom-client';
import { processRole } from '../config/role.js';

/**
 * Prometheus metrics. Every process exposes its own registry (the API on
 * GET /metrics, the others on their ops server), labelled with `role`.
 *
 * - Process-local counters/histograms are recorded where the work happens:
 *   HTTP requests (API), outbox publishing (publisher), job attempts and
 *   stream entries (worker), recovery and retention actions (recovery).
 * - Cluster state that lives in PostgreSQL (queue depth, waiting age, worker
 *   utilization, outbox backlog) is computed by the API at scrape time; see
 *   clusterMetrics.js. Scrape one API instance for those.
 *
 * Labels are bounded: queue IDs, statuses and fixed outcome names only.
 */
export const registry = new client.Registry();
registry.setDefaultLabels({ role: processRole });
client.collectDefaultMetrics({ register: registry, prefix: 'queueforge_' });

const SHORT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const JOB_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800];
const LAG_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900];

// --- API ---------------------------------------------------------------------
export const httpRequestDuration = new client.Histogram({
  name: 'queueforge_http_request_duration_seconds',
  help: 'HTTP request duration by method, matched route and status code',
  labelNames: ['method', 'route', 'status_code'],
  buckets: SHORT_BUCKETS,
  registers: [registry],
});

// --- Outbox publisher --------------------------------------------------------
export const outboxEventsTotal = new client.Counter({
  name: 'queueforge_outbox_events_total',
  help: 'Outbox events handled by this publisher: published, failed (retried later) or lost (claim taken over)',
  labelNames: ['result'],
  registers: [registry],
});

export const outboxPublishLag = new client.Histogram({
  name: 'queueforge_outbox_publish_lag_seconds',
  help: 'Time from an outbox event being committed to its stream entry being written (PostgreSQL clock)',
  buckets: LAG_BUCKETS,
  registers: [registry],
});

// --- Worker --------------------------------------------------------------------
export const jobAttemptsTotal = new client.Counter({
  name: 'queueforge_job_attempts_total',
  help: 'Finished job attempts by queue and outcome (completed, retrying, failed, dead, cancelled, interrupted, lease_lost, fenced)',
  labelNames: ['queue_id', 'outcome'],
  registers: [registry],
});

export const jobExecutionDuration = new client.Histogram({
  name: 'queueforge_job_execution_duration_seconds',
  help: 'Job attempt duration from claim to outcome, by queue and outcome',
  labelNames: ['queue_id', 'outcome'],
  buckets: JOB_BUCKETS,
  registers: [registry],
});

export const streamEntriesTotal = new client.Counter({
  name: 'queueforge_worker_stream_entries_total',
  help: 'Stream entries handled by this worker, by outcome (e.g. completed, discarded:terminal, deferred:queue-at-capacity, pending:claim-error)',
  labelNames: ['outcome', 'acked'],
  registers: [registry],
});

/** Gauges read from a running Worker at scrape time. Call once per process. */
export const registerWorkerGauges = (worker) => {
  const running = () => worker.runningJobs.size;
  new client.Gauge({
    name: 'queueforge_worker_running_jobs',
    help: 'Job handlers executing in this worker',
    registers: [registry],
    collect() {
      this.set(running());
    },
  });
  new client.Gauge({
    name: 'queueforge_worker_concurrency',
    help: 'Maximum concurrent jobs for this worker',
    registers: [registry],
    collect() {
      this.set(worker.config.concurrency);
    },
  });
  new client.Gauge({
    name: 'queueforge_worker_utilization_ratio',
    help: 'Running jobs divided by concurrency for this worker',
    registers: [registry],
    collect() {
      this.set(worker.config.concurrency > 0 ? running() / worker.config.concurrency : 0);
    },
  });
  new client.Gauge({
    name: 'queueforge_worker_deferred_entries',
    help: 'Stream entries held because their queue was at its concurrency limit',
    registers: [registry],
    collect() {
      this.set(worker.deferred.size);
    },
  });
};

// --- Recovery ------------------------------------------------------------------
export const recoveryActionsTotal = new client.Counter({
  name: 'queueforge_recovery_actions_total',
  help: 'Recovery actions: lease_recovered (by next_status), scheduled_released, retry_released, worker_unhealthy',
  labelNames: ['action', 'next_status'],
  registers: [registry],
});

export const retentionDeletedTotal = new client.Counter({
  name: 'queueforge_retention_deleted_total',
  help: 'Rows and stream data removed by retention, by kind',
  labelNames: ['kind'],
  registers: [registry],
});

/** Prometheus text exposition of this process's registry. */
export const renderMetrics = async () => ({
  contentType: registry.contentType,
  body: await registry.metrics(),
});

export { client as promClient };
