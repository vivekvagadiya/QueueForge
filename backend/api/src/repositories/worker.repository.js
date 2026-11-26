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
