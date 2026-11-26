import { DataTypes, Model } from 'sequelize';

export const WORKER_STATUSES = Object.freeze([
  'STARTING',
  'RUNNING',
  'DRAINING',
  'STOPPED',
  'UNHEALTHY',
]);

export class Worker extends Model {
  static initModel(sequelize) {
    return Worker.init(
      {
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        name: { type: DataTypes.STRING(100), allowNull: false },
        hostname: { type: DataTypes.STRING(255), allowNull: false },
        processId: { type: DataTypes.INTEGER, allowNull: false },
        status: {
          type: DataTypes.STRING(20),
          allowNull: false,
          defaultValue: 'STARTING',
          validate: { isIn: [WORKER_STATUSES] },
        },
        concurrency: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 1,
          validate: { min: 1 },
        },
        activeJobs: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        queues: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        lastHeartbeatAt: { type: DataTypes.DATE, allowNull: true },
        startedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        stoppedAt: { type: DataTypes.DATE, allowNull: true },
      },
      { sequelize, modelName: 'Worker', tableName: 'workers', underscored: true }
    );
  }

  static associate({ JobAttempt }) {
    Worker.hasMany(JobAttempt, { foreignKey: 'workerId', as: 'attempts' });
  }
}
