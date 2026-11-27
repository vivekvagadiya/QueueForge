/**
 * Correlation ID of the unit of work that created an outbox event (the API
 * request, or the recovery pass that released the job). The publisher copies
 * it into the stream entry so the worker's logs for the job share it.
 * Nullable: events created before this migration have none.
 */
export const up = async ({ queryInterface, Sequelize }) => {
  await queryInterface.addColumn('outbox_events', 'correlation_id', {
    type: Sequelize.STRING(128),
    allowNull: true,
  });
};

export const down = async ({ queryInterface }) => {
  await queryInterface.removeColumn('outbox_events', 'correlation_id');
};
