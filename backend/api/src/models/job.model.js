import { DataTypes, Model } from 'sequelize';

export const JOB_STATUSES = Object.freeze([
  'SCHEDULED',
  'WAITING',
  'ACTIVE',
  'RETRYING',
  'COMPLETED',
  'FAILED',
  'DEAD',
  'CANCELLED',
]);

export const TERMINAL_JOB_STATUSES = Object.freeze(['COMPLETED', 'FAILED', 'DEAD', 'CANCELLED']);

export class Job extends Model {
  static initModel(sequelize) {
    return Job.init(
      {
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        queueId: { type: DataTypes.UUID, allowNull: false },
        name: { type: DataTypes.STRING(255), allowNull: false },
        payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        status: {
          type: DataTypes.STRING(20),
          allowNull: false,
          defaultValue: 'WAITING',
          validate: { isIn: [JOB_STATUSES] },
        },
        priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        attemptsMade: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        maxAttempts: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 3,
          validate: { min: 1 },
        },
        scheduledAt: { type: DataTypes.DATE, allowNull: true },
        startedAt: { type: DataTypes.DATE, allowNull: true },
        completedAt: { type: DataTypes.DATE, allowNull: true },
        lockedBy: { type: DataTypes.UUID, allowNull: true },
        lockExpiresAt: { type: DataTypes.DATE, allowNull: true },
        // BIGINT is returned as a string by pg; compare fencing tokens as strings/BigInt.
        leaseVersion: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        idempotencyKey: { type: DataTypes.STRING(255), allowNull: true },
        result: { type: DataTypes.JSONB, allowNull: true },
        lastError: { type: DataTypes.JSONB, allowNull: true },
      },
      { sequelize, modelName: 'Job', tableName: 'jobs', underscored: true }
    );
  }

  static associate({ Queue, JobAttempt }) {
    Job.belongsTo(Queue, { foreignKey: 'queueId', as: 'queue' });
    Job.hasMany(JobAttempt, { foreignKey: 'jobId', as: 'attempts' });
  }
}
