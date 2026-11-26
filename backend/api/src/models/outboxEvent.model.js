import { DataTypes, Model } from 'sequelize';

export const OUTBOX_STATUSES = Object.freeze(['PENDING', 'PROCESSING', 'PUBLISHED']);

export const OUTBOX_EVENT_TYPES = Object.freeze({
  JOB_READY: 'job.ready',
});

export class OutboxEvent extends Model {
  static initModel(sequelize) {
    return OutboxEvent.init(
      {
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        aggregateType: { type: DataTypes.STRING(50), allowNull: false },
        aggregateId: { type: DataTypes.UUID, allowNull: false },
        eventType: { type: DataTypes.STRING(100), allowNull: false },
        payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        status: {
          type: DataTypes.STRING(20),
          allowNull: false,
          defaultValue: 'PENDING',
          validate: { isIn: [OUTBOX_STATUSES] },
        },
        attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        nextAttemptAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        lockedBy: { type: DataTypes.STRING(255), allowNull: true },
        lockedAt: { type: DataTypes.DATE, allowNull: true },
        lastError: { type: DataTypes.TEXT, allowNull: true },
        publishedAt: { type: DataTypes.DATE, allowNull: true },
        streamId: { type: DataTypes.STRING(64), allowNull: true },
      },
      { sequelize, modelName: 'OutboxEvent', tableName: 'outbox_events', underscored: true }
    );
  }
}
