import { QueryTypes } from 'sequelize';
import { getDatabase } from '../config/database.js';

/**
 * Retention deletes (recovery process). Each call deletes at most `limit` rows,
 * oldest first, so a large backlog is worked off in short transactions.
 * Rows are picked with FOR UPDATE SKIP LOCKED, so several recovery instances
 * can run retention at once. Ages are compared with PostgreSQL NOW().
 */

const select = (sql, bind) => getDatabase().query(sql, { bind, type: QueryTypes.SELECT });

const AGE = (param) => `NOW() - make_interval(secs => ${param}::double precision / 1000)`;

// Status lists are inlined (constants, not input) so the planner can match the
// partial index jobs_terminal_completed_at_idx.
const deleteJobs = (statusList) => async ({ olderThanMs, limit }) => {
  const rows = await select(
    `WITH doomed AS (
       SELECT id FROM jobs
       WHERE status IN (${statusList}) AND completed_at < ${AGE('$1')}
       ORDER BY completed_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM jobs j USING doomed
     WHERE j.id = doomed.id
     RETURNING j.id`,
    [olderThanMs, limit]
  );
  return rows.length;
};

export const retentionRepository = {
  /** COMPLETED jobs finished more than `olderThanMs` ago. Attempts are deleted by FK cascade. */
  deleteCompletedJobs: deleteJobs(`'COMPLETED'`),

  /** FAILED, DEAD and CANCELLED jobs finished more than `olderThanMs` ago. */
  deleteFailedJobs: deleteJobs(`'FAILED', 'DEAD', 'CANCELLED'`),

  /** PUBLISHED outbox events older than `olderThanMs`. PENDING/PROCESSING rows are never deleted. */
  async deletePublishedOutboxEvents({ olderThanMs, limit }) {
    const rows = await select(
      `WITH doomed AS (
         SELECT id FROM outbox_events
         WHERE status = 'PUBLISHED' AND published_at < ${AGE('$1')}
         ORDER BY published_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM outbox_events o USING doomed
       WHERE o.id = doomed.id
       RETURNING o.id`,
      [olderThanMs, limit]
    );
    return rows.length;
  },

  /** Every queue, archived included: their streams need trimming too. */
  async listAllQueueIds() {
    const rows = await select(`SELECT id FROM queues ORDER BY created_at`);
    return rows.map((r) => r.id);
  },

  /**
   * Of the given worker IDs, those that may still be alive: not STOPPED and
   * heard from within `withinMs`. Their stream consumers are never deleted.
   */
  async findLiveWorkerIds({ workerIds, withinMs }) {
    if (workerIds.length === 0) return new Set();
    const rows = await select(
      `SELECT id FROM workers
       WHERE id = ANY($1::uuid[])
         AND status <> 'STOPPED'
         AND COALESCE(last_heartbeat_at, started_at) >= ${AGE('$2')}`,
      [workerIds, withinMs]
    );
    return new Set(rows.map((r) => r.id));
  },
};
