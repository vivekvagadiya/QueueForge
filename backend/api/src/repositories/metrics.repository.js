import { QueryTypes } from 'sequelize';
import { getDatabase } from '../config/database.js';
import { outboxRepository } from './outbox.repository.js';

const select = (sql) => getDatabase().query(sql, { type: QueryTypes.SELECT });

/**
 * System-wide aggregates for metrics (not user-scoped). Only non-terminal jobs
 * are counted, so the cost tracks the live backlog, not the job history;
 * finished work is measured by the workers' counters instead.
 */
export const metricsRepository = {
  async snapshot() {
    const [queues, jobs, workers, outbox] = await Promise.all([
      select(`SELECT id FROM queues WHERE status <> 'ARCHIVED'`),
      // A WAITING job's updated_at is when it became WAITING (submission,
      // scheduler release, retry release, resume leaves it alone).
      select(
        `SELECT queue_id, status, COUNT(*)::int AS count,
                EXTRACT(EPOCH FROM NOW() - MIN(updated_at))::float8 AS oldest_age_seconds
         FROM jobs
         WHERE status IN ('SCHEDULED', 'WAITING', 'ACTIVE', 'RETRYING')
         GROUP BY queue_id, status`
      ),
      select(
        `SELECT status, COUNT(*)::int AS count,
                COALESCE(SUM(active_jobs), 0)::int AS active_jobs,
                COALESCE(SUM(concurrency), 0)::int AS concurrency
         FROM workers
         GROUP BY status`
      ),
      outboxRepository.stats(),
    ]);
    return { queueIds: queues.map((q) => q.id), jobs, workers, outbox };
  },
};
