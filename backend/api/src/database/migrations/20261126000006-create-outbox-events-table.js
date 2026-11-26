/**
 * Transactional outbox (ADR-004). A row is written in the same transaction as
 * the state change it announces; the publisher process later delivers it to
 * Redis Streams. Delivery is at-least-once, so consumers must tolerate duplicates.
 */
export const up = async ({ queryInterface, Sequelize }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'outbox_events',
      {
        id: {
          type: Sequelize.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        aggregate_type: { type: Sequelize.STRING(50), allowNull: false },
        aggregate_id: { type: Sequelize.UUID, allowNull: false },
        event_type: { type: Sequelize.STRING(100), allowNull: false },
        payload: {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: Sequelize.literal(`'{}'::jsonb`),
        },
        status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'PENDING' },
        // Number of publish attempts (claims) so far.
        attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        next_attempt_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('NOW()'),
        },
        // Publisher instance holding the claim while status = PROCESSING.
        locked_by: { type: Sequelize.STRING(255), allowNull: true },
        locked_at: { type: Sequelize.DATE, allowNull: true },
        last_error: { type: Sequelize.TEXT, allowNull: true },
        published_at: { type: Sequelize.DATE, allowNull: true },
        // Redis stream entry ID of the (last) successful XADD.
        stream_id: { type: Sequelize.STRING(64), allowNull: true },
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
      `ALTER TABLE outbox_events
         ADD CONSTRAINT outbox_events_status_check
           CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED')),
         ADD CONSTRAINT outbox_events_attempts_check CHECK (attempts >= 0),
         ADD CONSTRAINT outbox_events_processing_lock_check CHECK (
           status <> 'PROCESSING' OR (locked_by IS NOT NULL AND locked_at IS NOT NULL)
         ),
         ADD CONSTRAINT outbox_events_published_check CHECK (
           status <> 'PUBLISHED' OR published_at IS NOT NULL
         );

       -- Publisher polling: due pending events in creation order.
       CREATE INDEX outbox_events_pending_due_idx
         ON outbox_events (next_attempt_at, created_at) WHERE status = 'PENDING';

       -- Publisher recovery: claims abandoned by a crashed publisher.
       CREATE INDEX outbox_events_processing_locked_at_idx
         ON outbox_events (locked_at) WHERE status = 'PROCESSING';

       -- Look up events for a job (debugging, dashboard).
       CREATE INDEX outbox_events_aggregate_idx
         ON outbox_events (aggregate_type, aggregate_id);`,
      { transaction }
    );
  });
};

export const down = async ({ queryInterface }) => {
  await queryInterface.dropTable('outbox_events');
};
