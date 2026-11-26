export const up = async ({ queryInterface, Sequelize }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'workers',
      {
        id: {
          type: Sequelize.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        name: { type: Sequelize.STRING(100), allowNull: false },
        hostname: { type: Sequelize.STRING(255), allowNull: false },
        process_id: { type: Sequelize.INTEGER, allowNull: false },
        status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'STARTING' },
        concurrency: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
        active_jobs: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        // Queue IDs this worker consumes from.
        queues: {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: Sequelize.literal(`'[]'::jsonb`),
        },
        last_heartbeat_at: { type: Sequelize.DATE, allowNull: true },
        started_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('NOW()'),
        },
        stopped_at: { type: Sequelize.DATE, allowNull: true },
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
      `ALTER TABLE workers
         ADD CONSTRAINT workers_status_check
           CHECK (status IN ('STARTING', 'RUNNING', 'DRAINING', 'STOPPED', 'UNHEALTHY')),
         ADD CONSTRAINT workers_concurrency_check CHECK (concurrency > 0),
         ADD CONSTRAINT workers_active_jobs_check CHECK (active_jobs >= 0);

       -- Health monitoring: find live workers with stale heartbeats.
       CREATE INDEX workers_status_last_heartbeat_at_idx
         ON workers (status, last_heartbeat_at);`,
      { transaction }
    );
  });
};

export const down = async ({ queryInterface }) => {
  await queryInterface.dropTable('workers');
};
