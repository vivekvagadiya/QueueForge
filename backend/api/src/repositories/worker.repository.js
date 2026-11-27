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
   * System-level queue discovery for workers configured with WORKER_QUEUES="*".
   * Deliberately not user-scoped: workers serve every tenant.
   */
  async listConsumableQueueIds() {
    const rows = await getDatabase().query(
      `SELECT id FROM queues WHERE status <> 'ARCHIVED' ORDER BY created_at`,
      { type: QueryTypes.SELECT }
    );
    return rows.map((r) => r.id);
  },
};
