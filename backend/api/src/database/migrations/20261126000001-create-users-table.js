export const up = async ({ queryInterface, Sequelize }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'users',
      {
        id: {
          type: Sequelize.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        name: { type: Sequelize.STRING(100), allowNull: false },
        email: { type: Sequelize.STRING(255), allowNull: false },
        password_hash: { type: Sequelize.STRING(255), allowNull: false },
        status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'ACTIVE' },
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
      `ALTER TABLE users
         ADD CONSTRAINT users_status_check CHECK (status IN ('ACTIVE', 'DISABLED'));
       CREATE UNIQUE INDEX users_email_lower_unique ON users (LOWER(email));`,
      { transaction }
    );
  });
};

export const down = async ({ queryInterface }) => {
  await queryInterface.dropTable('users');
};
