import { DataTypes, Model } from 'sequelize';

export const QUEUE_STATUSES = Object.freeze(['ACTIVE', 'PAUSED', 'ARCHIVED']);

export class Queue extends Model {
  static initModel(sequelize) {
    return Queue.init(
      {
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        userId: { type: DataTypes.UUID, allowNull: false },
        name: { type: DataTypes.STRING(100), allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        status: {
          type: DataTypes.STRING(20),
          allowNull: false,
          defaultValue: 'ACTIVE',
          validate: { isIn: [QUEUE_STATUSES] },
        },
        concurrency: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 1,
          validate: { min: 1 },
        },
        defaultJobOptions: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      },
      { sequelize, modelName: 'Queue', tableName: 'queues', underscored: true }
    );
  }

  static associate({ User, Job }) {
    Queue.belongsTo(User, { foreignKey: 'userId', as: 'owner' });
    Queue.hasMany(Job, { foreignKey: 'queueId', as: 'jobs' });
  }
}
