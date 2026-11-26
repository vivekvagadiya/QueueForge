export const up = async ({ queryInterface, Sequelize }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'job_attempts',
      {
        id: {
          type: Sequelize.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        job_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'jobs', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        attempt_number: { type: Sequelize.INTEGER, allowNull: false },
        // Nullable: an attempt can be recorded without worker attribution
        // (e.g. some recovery paths), and history survives worker cleanup.
        worker_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: 'workers', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'RUNNING' },
        // Fencing token held by the worker for this attempt.
        lease_version: { type: Sequelize.BIGINT, allowNull: false },
        started_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('NOW()'),
        },
        finished_at: { type: Sequelize.DATE, allowNull: true },
        duration_ms: { type: Sequelize.INTEGER, allowNull: true },
        error_code: { type: Sequelize.STRING(100), allowNull: true },
        error_message: { type: Sequelize.TEXT, allowNull: true },
        error_stack: { type: Sequelize.TEXT, allowNull: true },
        result: { type: Sequelize.JSONB, allowNull: true },
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

    await queryInterface.sequelize.query(
      `ALTER TABLE job_attempts
         ADD CONSTRAINT job_attempts_status_check
           CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED', 'CANCELLED')),
         ADD CONSTRAINT job_attempts_attempt_number_check CHECK (attempt_number > 0),
         ADD CONSTRAINT job_attempts_duration_ms_check CHECK (duration_ms IS NULL OR duration_ms >= 0),
         ADD CONSTRAINT job_attempts_job_id_attempt_number_unique UNIQUE (job_id, attempt_number);

       CREATE INDEX job_attempts_worker_id_idx ON job_attempts (worker_id);`,
      { transaction }
    );
  });
};

export const down = async ({ queryInterface }) => {
  await queryInterface.dropTable('job_attempts');
};
