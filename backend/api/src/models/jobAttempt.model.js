import { DataTypes, Model } from 'sequelize';

export const JOB_ATTEMPT_STATUSES = Object.freeze([
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'INTERRUPTED',
  'CANCELLED',
]);

export class JobAttempt extends Model {
  static initModel(sequelize) {
    return JobAttempt.init(
      {
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        jobId: { type: DataTypes.UUID, allowNull: false },
        attemptNumber: {
          type: DataTypes.INTEGER,
          allowNull: false,
          validate: { min: 1 },
        },
        workerId: { type: DataTypes.UUID, allowNull: true },
        status: {
          type: DataTypes.STRING(20),
          allowNull: false,
          defaultValue: 'RUNNING',
          validate: { isIn: [JOB_ATTEMPT_STATUSES] },
        },
        leaseVersion: { type: DataTypes.BIGINT, allowNull: false },
        startedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        finishedAt: { type: DataTypes.DATE, allowNull: true },
        durationMs: { type: DataTypes.INTEGER, allowNull: true },
        errorCode: { type: DataTypes.STRING(100), allowNull: true },
        errorMessage: { type: DataTypes.TEXT, allowNull: true },
        errorStack: { type: DataTypes.TEXT, allowNull: true },
        result: { type: DataTypes.JSONB, allowNull: true },
      },
      { sequelize, modelName: 'JobAttempt', tableName: 'job_attempts', underscored: true }
    );
  }

  static associate({ Job, Worker }) {
    JobAttempt.belongsTo(Job, { foreignKey: 'jobId', as: 'job' });
    JobAttempt.belongsTo(Worker, { foreignKey: 'workerId', as: 'worker' });
  }
}
