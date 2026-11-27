import { QueryTypes } from 'sequelize';
import { getDatabase } from '../config/database.js';
import { OUTBOX_EVENT_TYPES } from '../models/outboxEvent.model.js';
import { getCorrelationId } from '../observability/context.js';

/**
 * System-level maintenance queries used by the recovery process. Not user-scoped.
 *
 * Every query is safe to run from several recovery instances at once: rows are
 * selected with FOR UPDATE SKIP LOCKED, and the outer UPDATE re-checks the
 * condition, so a job a worker renewed or finished meanwhile is left alone.
 * All time comparisons use PostgreSQL NOW().
 */

const select = (sql, bind, transaction) =>
  getDatabase().query(sql, { bind, type: QueryTypes.SELECT, transaction });

// Same formula as utils/backoff.js: random delay in [d/2, d], d = min(max, base * 2^(attempt-1)).
const BACKOFF_SQL = (attemptsExpr) =>
  `make_interval(secs => LEAST($3::double precision,
       $2::double precision * power(2, GREATEST(0, ${attemptsExpr} - 1)))
     * (0.5 + random() * 0.5) / 1000)`;

/**
 * Jobs in `status` whose scheduled_at has passed -> WAITING, plus a fresh
 * job.ready outbox event for each, in one transaction (event policy: every
 * transition into WAITING emits an event). One status per statement so each
 * uses its own partial index (jobs_scheduled_due_idx / jobs_retrying_due_idx).
 *
 * Jobs in paused queues are released too; workers won't claim them until the
 * queue is resumed, and resuming re-announces every WAITING job.
 */
const releaseDue = (status, { limit }) =>
  getDatabase().transaction(async (transaction) => {
    const released = await select(
      `WITH due AS (
         SELECT id FROM jobs
         WHERE status = $2::text AND scheduled_at <= NOW()
         ORDER BY scheduled_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE jobs j
       SET status = 'WAITING', updated_at = NOW()
       FROM due
       WHERE j.id = due.id AND j.status = $2::text
       RETURNING j.id, j.queue_id`,
      [limit, status],
      transaction
    );
    if (released.length > 0) {
      await select(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, correlation_id)
         SELECT 'job', r.id, $2, jsonb_build_object('jobId', r.id, 'queueId', r.queue_id), $3::varchar
         FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, queue_id uuid)
         RETURNING id`,
        // The recovery pass's correlation ID, so the worker's logs link back to it.
        [JSON.stringify(released), OUTBOX_EVENT_TYPES.JOB_READY, getCorrelationId()],
        transaction
      );
    }
    return released.map((r) => r.id);
  });

export const recoveryRepository = {
  /** Scheduler: due SCHEDULED jobs (delayMs / scheduledAt) -> WAITING + job.ready. Returns IDs. */
  releaseDueScheduled: ({ limit }) => releaseDue('SCHEDULED', { limit }),

  /** Due RETRYING jobs -> WAITING + job.ready. Returns IDs. */
  releaseDueRetries: ({ limit }) => releaseDue('RETRYING', { limit }),

  /**
   * ACTIVE jobs whose lease expired (worker crashed, hung, or lost the database):
   * the running attempt becomes INTERRUPTED, and the job goes to RETRYING with
   * backoff, or DEAD if that was its last allowed attempt. One statement, so
   * the job and its attempt history change atomically.
   *
   * The interrupted attempt counts toward max_attempts: a job that kills its
   * worker every time must eventually stop being retried. A job the user asked
   * to cancel becomes CANCELLED instead of being retried.
   */
  async recoverExpiredLeases({ limit, retryBaseMs, retryMaxMs }) {
    return select(
      `WITH expired AS (
         SELECT id, attempts_made, max_attempts, locked_by, lease_version,
                CASE WHEN cancel_requested_at IS NOT NULL THEN 'CANCELLED'
                     WHEN attempts_made >= max_attempts THEN 'DEAD'
                     ELSE 'RETRYING' END AS next_status
         FROM jobs
         WHERE status = 'ACTIVE' AND lock_expires_at < NOW()
         ORDER BY lock_expires_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       ),
       recovered AS (
         UPDATE jobs j
         SET status = e.next_status,
             scheduled_at = CASE WHEN e.next_status = 'RETRYING'
                                 THEN NOW() + ${BACKOFF_SQL('e.attempts_made')}
                                 ELSE j.scheduled_at END,
             completed_at = CASE WHEN e.next_status = 'RETRYING' THEN NULL ELSE NOW() END,
             last_error = jsonb_build_object(
               'code', 'LEASE_EXPIRED',
               'message', 'Worker lease expired before the attempt finished',
               'attempt', e.attempts_made),
             locked_by = NULL,
             lock_expires_at = NULL,
             updated_at = NOW()
         FROM expired e
         WHERE j.id = e.id AND j.status = 'ACTIVE' AND j.lock_expires_at < NOW()
         RETURNING j.id, j.queue_id, j.status, e.attempts_made, e.locked_by, e.lease_version
       ),
       interrupted AS (
         UPDATE job_attempts a
         SET status = 'INTERRUPTED',
             finished_at = NOW(),
             duration_ms = GREATEST(0, ROUND(EXTRACT(EPOCH FROM NOW() - a.started_at) * 1000))::int,
             error_code = 'LEASE_EXPIRED',
             error_message = 'Worker lease expired before the attempt finished',
             updated_at = NOW()
         FROM recovered r
         WHERE a.job_id = r.id AND a.attempt_number = r.attempts_made AND a.status = 'RUNNING'
         RETURNING a.job_id
       )
       SELECT r.id, r.queue_id, r.status, r.attempts_made, r.locked_by,
              r.lease_version::text AS lease_version,
              EXISTS (SELECT 1 FROM interrupted i WHERE i.job_id = r.id) AS attempt_interrupted
       FROM recovered r`,
      [limit, retryBaseMs, retryMaxMs]
    );
  },

  /**
   * Workers that stopped heartbeating -> UNHEALTHY. Informational: job safety
   * comes from leases, not from this flag. A worker that comes back sets its
   * own status again on its next heartbeat.
   */
  async markStaleWorkers({ heartbeatTimeoutMs }) {
    const rows = await select(
      `UPDATE workers
       SET status = 'UNHEALTHY', updated_at = NOW()
       WHERE status IN ('STARTING', 'RUNNING', 'DRAINING')
         AND COALESCE(last_heartbeat_at, started_at)
             < NOW() - make_interval(secs => $1::double precision / 1000)
       RETURNING id, name`,
      [heartbeatTimeoutMs]
    );
    return rows;
  },
};
