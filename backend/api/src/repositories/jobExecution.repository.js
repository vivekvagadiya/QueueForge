import { QueryTypes } from 'sequelize';
import { getDatabase } from '../config/database.js';

/**
 * Execution-side job state changes (workers only; not user-scoped).
 *
 * Ownership rules (docs/distributed-systems/job-claiming.md):
 * - Only a successful claim (WAITING -> ACTIVE) grants the right to execute.
 * - Every write after the claim is fenced on (job id, locked_by, lease_version,
 *   status = ACTIVE). If recovery or another worker has taken over, the write
 *   matches zero rows and the stale worker's outcome is discarded.
 * - Time comparisons use PostgreSQL NOW().
 */

const select = (sql, bind, transaction) =>
  getDatabase().query(sql, { bind, type: QueryTypes.SELECT, transaction });

const ERROR_MESSAGE_MAX = 2000;
const ERROR_STACK_MAX = 8000;

export const jobExecutionRepository = {
  /**
   * Atomically claims a WAITING job and records the new attempt in one
   * transaction. Returns:
   * - the claim (with the fencing token) on success;
   * - `{ rejected: 'QUEUE_NOT_ACTIVE' }` when the queue is paused or archived;
   * - `{ rejected: 'QUEUE_AT_CAPACITY' }` when the queue already runs
   *   `queues.concurrency` jobs;
   * - null when the job itself is not claimable (not WAITING, missing, wrong queue).
   * Throws on database errors.
   *
   * The queue row is locked first (FOR NO KEY UPDATE), which serializes claims
   * per queue: the ACTIVE count read under the lock includes every committed
   * claim, so the concurrency limit holds across worker processes, and a claim
   * can never interleave with a pause. NO KEY UPDATE does not conflict with the
   * KEY SHARE lock that job inserts take on their queue, so submission is not blocked.
   */
  claim: ({ jobId, queueId, workerId, leaseMs }) =>
    getDatabase().transaction(async (transaction) => {
      const [queue] = await select(
        `SELECT status, concurrency FROM queues WHERE id = $1 FOR NO KEY UPDATE`,
        [queueId],
        transaction
      );
      if (!queue) {
        return null;
      }

      const [state] = await select(
        `SELECT (SELECT status FROM jobs WHERE id = $1 AND queue_id = $2) AS job_status,
                (SELECT count(*)::int FROM jobs WHERE queue_id = $2 AND status = 'ACTIVE') AS active`,
        [jobId, queueId],
        transaction
      );
      if (state.job_status !== 'WAITING') {
        return null;
      }
      if (queue.status !== 'ACTIVE') {
        return { rejected: 'QUEUE_NOT_ACTIVE', queueStatus: queue.status };
      }
      if (state.active >= queue.concurrency) {
        return { rejected: 'QUEUE_AT_CAPACITY', active: state.active, concurrency: queue.concurrency };
      }

      const [job] = await select(
        `UPDATE jobs
         SET status = 'ACTIVE',
             locked_by = $1,
             lock_expires_at = NOW() + make_interval(secs => $4::double precision / 1000),
             lease_version = lease_version + 1,
             attempts_made = attempts_made + 1,
             started_at = NOW(),
             updated_at = NOW()
         WHERE id = $2 AND queue_id = $3 AND status = 'WAITING'
         RETURNING id, queue_id, name, payload, attempts_made, max_attempts, lease_version`,
        [workerId, jobId, queueId, leaseMs],
        transaction
      );
      if (!job) {
        return null;
      }

      await select(
        `INSERT INTO job_attempts (job_id, attempt_number, worker_id, status, lease_version, started_at)
         VALUES ($1, $2, $3, 'RUNNING', $4, NOW())
         RETURNING id`,
        [job.id, job.attempts_made, workerId, job.lease_version],
        transaction
      );

      return {
        jobId: job.id,
        queueId: job.queue_id,
        name: job.name,
        payload: job.payload,
        attempt: job.attempts_made,
        maxAttempts: job.max_attempts,
        // BIGINT arrives as a string; keep it as a string to avoid precision loss.
        leaseVersion: String(job.lease_version),
        workerId,
      };
    }),

  /** Current state of a job, for deciding what to do after a failed claim. */
  async findState({ jobId }) {
    const [row] = await select(
      `SELECT id, queue_id, status, locked_by, lease_version, lock_expires_at > NOW() AS lease_valid
       FROM jobs WHERE id = $1`,
      [jobId]
    );
    return row
      ? {
          jobId: row.id,
          queueId: row.queue_id,
          status: row.status,
          lockedBy: row.locked_by,
          leaseVersion: String(row.lease_version),
          leaseValid: row.lease_valid === true,
        }
      : null;
  },

  /** ACTIVE -> COMPLETED. Returns false if the claim was fenced out. */
  complete: (claim, { result }) =>
    getDatabase().transaction(async (transaction) => {
      const updated = await select(
        `UPDATE jobs
         SET status = 'COMPLETED',
             result = $4::jsonb,
             last_error = NULL,
             completed_at = NOW(),
             locked_by = NULL,
             lock_expires_at = NULL,
             updated_at = NOW()
         WHERE id = $1 AND status = 'ACTIVE' AND locked_by = $2 AND lease_version = $3
         RETURNING id`,
        [claim.jobId, claim.workerId, claim.leaseVersion, JSON.stringify(result)],
        transaction
      );
      if (updated.length === 0) {
        return false;
      }

      await select(
        `UPDATE job_attempts
         SET status = 'SUCCEEDED',
             finished_at = NOW(),
             duration_ms = GREATEST(0, ROUND(EXTRACT(EPOCH FROM NOW() - started_at) * 1000))::int,
             result = $3::jsonb,
             updated_at = NOW()
         WHERE job_id = $1 AND attempt_number = $2 AND status = 'RUNNING'
         RETURNING id`,
        [claim.jobId, claim.attempt, JSON.stringify(result)],
        transaction
      );
      return true;
    }),

  /**
   * Extends the lease of a job this worker still owns. Returns false when the
   * job was recovered or re-claimed (lease lost): the caller must stop working on it.
   * Renewal is allowed after expiry as long as nobody has taken the job over.
   */
  async renewLease(claim, { leaseMs }) {
    const rows = await select(
      `UPDATE jobs
       SET lock_expires_at = NOW() + make_interval(secs => $4::double precision / 1000),
           updated_at = NOW()
       WHERE id = $1 AND status = 'ACTIVE' AND locked_by = $2 AND lease_version = $3
       RETURNING id`,
      [claim.jobId, claim.workerId, claim.leaseVersion, leaseMs]
    );
    return rows.length === 1;
  },

  /**
   * IDs of ACTIVE jobs held by this worker that a user asked to cancel.
   * Polled by the worker so it can abort those handlers cooperatively.
   */
  async findCancelRequested({ workerId }) {
    const rows = await select(
      `SELECT id, lease_version::text AS lease_version FROM jobs
       WHERE locked_by = $1 AND status = 'ACTIVE' AND cancel_requested_at IS NOT NULL`,
      [workerId]
    );
    return rows.map((r) => ({ jobId: r.id, leaseVersion: r.lease_version }));
  },

  /**
   * ACTIVE -> RETRYING (with scheduled_at = NOW() + retryDelayMs), FAILED,
   * DEAD, or CANCELLED. `attemptStatus` is FAILED for handler errors,
   * INTERRUPTED when the worker gave the job up (shutdown), and CANCELLED when
   * the handler stopped because of a cancel request.
   *
   * If a cancel was requested, the job becomes CANCELLED whatever `nextStatus`
   * says: a job the user cancelled is never retried.
   *
   * Returns the job's new status, or false if the claim was fenced out.
   */
  fail: (claim, { nextStatus, retryDelayMs, error, attemptStatus = 'FAILED' }) =>
    getDatabase().transaction(async (transaction) => {
      const lastError = {
        code: error.code,
        message: error.message.slice(0, ERROR_MESSAGE_MAX),
        attempt: claim.attempt,
      };

      const updated = await select(
        `UPDATE jobs
         SET status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'CANCELLED' ELSE $4::text END,
             scheduled_at = CASE WHEN $4::text = 'RETRYING' AND cancel_requested_at IS NULL
                                 THEN NOW() + make_interval(secs => $5::double precision / 1000)
                                 ELSE scheduled_at END,
             completed_at = CASE WHEN $4::text IN ('FAILED', 'DEAD', 'CANCELLED') OR cancel_requested_at IS NOT NULL
                                 THEN NOW() ELSE NULL END,
             last_error = $6::jsonb,
             locked_by = NULL,
             lock_expires_at = NULL,
             updated_at = NOW()
         WHERE id = $1 AND status = 'ACTIVE' AND locked_by = $2 AND lease_version = $3
         RETURNING id, status`,
        [
          claim.jobId,
          claim.workerId,
          claim.leaseVersion,
          nextStatus,
          retryDelayMs ?? 0,
          JSON.stringify(lastError),
        ],
        transaction
      );
      if (updated.length === 0) {
        return false;
      }

      await select(
        `UPDATE job_attempts
         SET status = $6::text,
             finished_at = NOW(),
             duration_ms = GREATEST(0, ROUND(EXTRACT(EPOCH FROM NOW() - started_at) * 1000))::int,
             error_code = $3,
             error_message = $4,
             error_stack = $5,
             updated_at = NOW()
         WHERE job_id = $1 AND attempt_number = $2 AND status = 'RUNNING'
         RETURNING id`,
        [
          claim.jobId,
          claim.attempt,
          error.code,
          error.message.slice(0, ERROR_MESSAGE_MAX),
          error.stack ? error.stack.slice(0, ERROR_STACK_MAX) : null,
          attemptStatus,
        ],
        transaction
      );
      return updated[0].status;
    }),
};
