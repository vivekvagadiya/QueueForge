export const up = async ({ queryInterface, Sequelize }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'queues',
      {
        id: {
          type: Sequelize.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        user_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        },
        name: { type: Sequelize.STRING(100), allowNull: false },
        description: { type: Sequelize.TEXT, allowNull: true },
        status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'ACTIVE' },
        concurrency: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
        default_job_options: {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: Sequelize.literal(`'{}'::jsonb`),
        },
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
      `ALTER TABLE queues
         ADD CONSTRAINT queues_status_check CHECK (status IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
         ADD CONSTRAINT queues_concurrency_check CHECK (concurrency > 0),
         ADD CONSTRAINT queues_user_id_name_unique UNIQUE (user_id, name);`,
      { transaction }
    );
  });
};

export const down = async ({ queryInterface }) => {
  await queryInterface.dropTable('queues');
};
