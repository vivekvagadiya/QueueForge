const JOB_STATUSES = [
  'SCHEDULED',
  'WAITING',
  'ACTIVE',
  'RETRYING',
  'COMPLETED',
  'FAILED',
  'DEAD',
  'CANCELLED',
];

export const up = async ({ queryInterface, Sequelize }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'jobs',
      {
        id: {
          type: Sequelize.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        queue_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'queues', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        },
        name: { type: Sequelize.STRING(255), allowNull: false },
        payload: {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: Sequelize.literal(`'{}'::jsonb`),
        },
        status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'WAITING' },
        priority: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        attempts_made: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        max_attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 3 },
        scheduled_at: { type: Sequelize.DATE, allowNull: true },
        started_at: { type: Sequelize.DATE, allowNull: true },
        completed_at: { type: Sequelize.DATE, allowNull: true },
        // Execution lease (see docs/distributed-systems/lease-heartbeat.md).
        // locked_by holds a workers.id; it has no FK because workers is created
        // later and a lease must survive worker-row cleanup until recovery runs.
        locked_by: { type: Sequelize.UUID, allowNull: true },
        lock_expires_at: { type: Sequelize.DATE, allowNull: true },
        // Fencing token: incremented on every successful claim.
        lease_version: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        idempotency_key: { type: Sequelize.STRING(255), allowNull: true },
        result: { type: Sequelize.JSONB, allowNull: true },
        last_error: { type: Sequelize.JSONB, allowNull: true },
        created_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('NOW()'),
        },
        updated_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('NOW()'),
        },
      },
      { transaction }
    );

    const statusList = JOB_STATUSES.map((s) => `'${s}'`).join(', ');

    await queryInterface.sequelize.query(
      `ALTER TABLE jobs
         ADD CONSTRAINT jobs_status_check CHECK (status IN (${statusList})),
         ADD CONSTRAINT jobs_attempts_made_check CHECK (attempts_made >= 0),
         ADD CONSTRAINT jobs_max_attempts_check CHECK (max_attempts > 0),
         ADD CONSTRAINT jobs_lease_version_check CHECK (lease_version >= 0),
         ADD CONSTRAINT jobs_active_lease_check CHECK (
           status <> 'ACTIVE' OR (locked_by IS NOT NULL AND lock_expires_at IS NOT NULL)
         ),
         ADD CONSTRAINT jobs_scheduled_at_check CHECK (
           status NOT IN ('SCHEDULED', 'RETRYING') OR scheduled_at IS NOT NULL
         );

       -- Idempotent submission, scoped to the queue.
       CREATE UNIQUE INDEX jobs_queue_id_idempotency_key_unique
         ON jobs (queue_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL;

       -- Job listing per queue filtered by status.
       CREATE INDEX jobs_queue_id_status_created_at_idx
         ON jobs (queue_id, status, created_at DESC);

       -- Scheduler: due scheduled jobs and due retries.
       CREATE INDEX jobs_scheduled_due_idx
         ON jobs (scheduled_at) WHERE status = 'SCHEDULED';
       CREATE INDEX jobs_retrying_due_idx
         ON jobs (scheduled_at) WHERE status = 'RETRYING';

       -- Recovery: expired leases.
       CREATE INDEX jobs_active_lock_expires_at_idx
         ON jobs (lock_expires_at) WHERE status = 'ACTIVE';`,
      { transaction }
    );
  });
};

export const down = async ({ queryInterface }) => {
  await queryInterface.dropTable('jobs');
};
