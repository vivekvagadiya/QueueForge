/**
 * Sprint 5 schema change (deliberate, documented in the roadmap):
 *
 * - jobs.cancel_requested_at: set when a user cancels an ACTIVE job. The job
 *   stays ACTIVE until its worker confirms the handler has stopped, so the API
 *   never reports a running job as cancelled. Also set (with status CANCELLED)
 *   when a job is cancelled before it ran.
 * - Indexes for retention: terminal jobs by completed_at, published outbox
 *   events by published_at.
 */
export const up = async ({ queryInterface, Sequelize }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.addColumn(
      'jobs',
      'cancel_requested_at',
      { type: Sequelize.DATE, allowNull: true },
      { transaction }
    );

    await queryInterface.sequelize.query(
      `-- Retention: finished jobs older than the configured age.
       CREATE INDEX jobs_terminal_completed_at_idx
         ON jobs (completed_at)
         WHERE status IN ('COMPLETED', 'FAILED', 'DEAD', 'CANCELLED');

       -- Workers poll for cancellation of the jobs they are running.
       CREATE INDEX jobs_active_cancel_requested_idx
         ON jobs (locked_by)
         WHERE status = 'ACTIVE' AND cancel_requested_at IS NOT NULL;

       -- Retention: published outbox events older than the configured age.
       CREATE INDEX outbox_events_published_at_idx
         ON outbox_events (published_at)
         WHERE status = 'PUBLISHED';`,
      { transaction }
    );
  });
};

export const down = async ({ queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS outbox_events_published_at_idx;
       DROP INDEX IF EXISTS jobs_active_cancel_requested_idx;
       DROP INDEX IF EXISTS jobs_terminal_completed_at_idx;`,
      { transaction }
    );
    await queryInterface.removeColumn('jobs', 'cancel_requested_at', { transaction });
  });
};
