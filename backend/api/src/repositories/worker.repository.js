import { QueryTypes } from 'sequelize';
import { getDatabase } from '../config/database.js';
import { Worker } from '../models/index.js';

export const workerRepository = {
  register: ({ name, hostname, processId, concurrency, queues }) =>
    Worker.create({
      name,
      hostname,
      processId,
      concurrency,
      queues,
      status: 'RUNNING',
      lastHeartbeatAt: new Date(),
    }),

  async setStatus(workerId, status) {
    await getDatabase().query(
      `UPDATE workers
       SET status = $2::text,
           stopped_at = CASE WHEN $2::text = 'STOPPED' THEN NOW() ELSE stopped_at END,
           updated_at = NOW()
       WHERE id = $1`,
      { bind: [workerId, status], type: QueryTypes.UPDATE }
    );
  },

  /**
   * Liveness signal. Also restores the worker's own status if recovery marked
   * it UNHEALTHY during a pause. Never revives a STOPPED worker.
   * Returns false if the row is gone or STOPPED.
   */
  async heartbeat(workerId, { status, activeJobs }) {
    const rows = await getDatabase().query(
      `UPDATE workers
       SET last_heartbeat_at = NOW(),
           status = $2::text,
           active_jobs = $3,
           updated_at = NOW()
       WHERE id = $1 AND status <> 'STOPPED'
       RETURNING id`,
      { bind: [workerId, status, activeJobs], type: QueryTypes.SELECT }
    );
    return rows.length === 1;
  },

  /**
   * Dashboard listing (read-only). Live workers first (anything not STOPPED),
   * then most recent heartbeat. `heartbeat_age_ms` is computed with PostgreSQL
   * NOW() so the browser's clock doesn't matter.
   */
  async list({ statuses, limit, offset }) {
    const where = statuses ? `WHERE status = ANY($1::text[])` : '';
    const bind = statuses ? [statuses] : [];
    const page = `LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
    const db = getDatabase();
    const [rows, [{ total }], counts] = await Promise.all([
      db.query(
        `SELECT id, name, hostname, process_id, status, concurrency, active_jobs, queues,
                last_heartbeat_at, started_at, stopped_at,
                ROUND(EXTRACT(EPOCH FROM NOW() - last_heartbeat_at) * 1000)::bigint AS heartbeat_age_ms
         FROM workers ${where}
         ORDER BY (status = 'STOPPED'), last_heartbeat_at DESC NULLS LAST, started_at DESC
         ${page}`,
        { bind, type: QueryTypes.SELECT }
      ),
      db.query(`SELECT COUNT(*)::int AS total FROM workers ${where}`, { bind, type: QueryTypes.SELECT }),
      // Counts per status over all workers (unfiltered), for the page summary.
      db.query(`SELECT status, COUNT(*)::int AS n FROM workers GROUP BY status`, { type: QueryTypes.SELECT }),
    ]);
    return {
      rows,
      total,
      statusCounts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    };
  },

  /**
   * System-level queue discovery for workers configured with WORKER_QUEUES="*".
   * Deliberately not user-scoped: workers serve every tenant.
   *
   * Paused and archived queues are left out, so their streams are not read
   * while they cannot dispatch. This is an optimization only: the claim checks
   * the queue status under a lock, and resuming re-announces WAITING jobs.
   */
  async listConsumableQueueIds() {
    const rows = await getDatabase().query(
      `SELECT id FROM queues WHERE status = 'ACTIVE' ORDER BY created_at`,
      { type: QueryTypes.SELECT }
    );
    return rows.map((r) => r.id);
  },
};
