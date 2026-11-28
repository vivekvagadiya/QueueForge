import { QueryTypes } from 'sequelize';
import { getDatabase } from '../config/database.js';

/**
 * Read-only aggregates for the Overview Dashboard, scoped to `userId` for
 * queues and jobs. Workers are cluster-wide (matching GET /workers).
 */
export const dashboardRepository = {
  async getSummary(userId) {
    const db = getDatabase();

    const [queueTotals] = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
         COUNT(*) FILTER (WHERE status = 'PAUSED')::int AS paused,
         COUNT(*) FILTER (WHERE status = 'ARCHIVED')::int AS archived
       FROM queues
       WHERE user_id = $1`,
      { bind: [userId], type: QueryTypes.SELECT }
    );

    const [jobTotals] = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE j.status = 'WAITING')::int AS waiting,
         COUNT(*) FILTER (WHERE j.status = 'SCHEDULED')::int AS scheduled,
         COUNT(*) FILTER (WHERE j.status = 'ACTIVE')::int AS active,
         COUNT(*) FILTER (WHERE j.status = 'RETRYING')::int AS retrying,
         COUNT(*) FILTER (WHERE j.status = 'COMPLETED')::int AS completed,
         COUNT(*) FILTER (WHERE j.status IN ('FAILED', 'DEAD'))::int AS failed,
         COUNT(*) FILTER (WHERE j.status = 'CANCELLED')::int AS cancelled
       FROM jobs j
       INNER JOIN queues q ON q.id = j.queue_id
       WHERE q.user_id = $1`,
      { bind: [userId], type: QueryTypes.SELECT }
    );

    const queues = await db.query(
      `SELECT
         q.id,
         q.name,
         q.status,
         q.concurrency,
         q.created_at AS "createdAt",
         COUNT(j.id) FILTER (WHERE j.status IN ('WAITING', 'SCHEDULED'))::int AS "waitingCount",
         COUNT(j.id) FILTER (WHERE j.status = 'ACTIVE')::int AS "activeCount",
         COUNT(j.id) FILTER (WHERE j.status = 'COMPLETED')::int AS "completedCount",
         COUNT(j.id) FILTER (WHERE j.status IN ('FAILED', 'DEAD'))::int AS "failedCount"
       FROM queues q
       LEFT JOIN jobs j ON j.queue_id = q.id
       WHERE q.user_id = $1
       GROUP BY q.id
       ORDER BY q.created_at DESC, q.id DESC
       LIMIT 6`,
      { bind: [userId], type: QueryTypes.SELECT }
    );

    const recentJobs = await db.query(
      `SELECT
         j.id,
         j.queue_id AS "queueId",
         q.name AS "queueName",
         j.name,
         j.status,
         j.priority,
         j.created_at AS "createdAt",
         j.started_at AS "startedAt",
         j.completed_at AS "completedAt"
       FROM jobs j
       INNER JOIN queues q ON q.id = j.queue_id
       WHERE q.user_id = $1
       ORDER BY j.created_at DESC, j.id DESC
       LIMIT 8`,
      { bind: [userId], type: QueryTypes.SELECT }
    );

    const [workerTotals] = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'RUNNING')::int AS running,
         COUNT(*) FILTER (WHERE status = 'DRAINING')::int AS draining,
         COUNT(*) FILTER (WHERE status = 'UNHEALTHY')::int AS unhealthy,
         COUNT(*) FILTER (WHERE status = 'STARTING')::int AS starting,
         COUNT(*) FILTER (WHERE status = 'STOPPED')::int AS stopped
       FROM workers`,
      { type: QueryTypes.SELECT }
    );

    const workers = await db.query(
      `SELECT
         id,
         name,
         hostname,
         status,
         concurrency,
         active_jobs AS "activeJobs",
         queues,
         last_heartbeat_at AS "lastHeartbeatAt",
         EXTRACT(EPOCH FROM (NOW() - last_heartbeat_at)) * 1000 AS "heartbeatAgeMs"
       FROM workers
       WHERE status <> 'STOPPED'
       ORDER BY last_heartbeat_at DESC NULLS LAST, started_at DESC
       LIMIT 6`,
      { type: QueryTypes.SELECT }
    );

    return {
      queues: queueTotals,
      jobs: jobTotals,
      workers: workerTotals,
      recentQueues: queues,
      recentJobs,
      activeWorkers: workers.map((w) => ({
        ...w,
        heartbeatAgeMs: w.heartbeatAgeMs === null ? null : Math.max(0, Math.round(Number(w.heartbeatAgeMs))),
      })),
    };
  },
};
