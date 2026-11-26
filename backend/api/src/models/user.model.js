import { DataTypes, Model } from 'sequelize';

export const USER_STATUSES = Object.freeze(['ACTIVE', 'DISABLED']);

export class User extends Model {
  static initModel(sequelize) {
    return User.init(
      {
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        name: { type: DataTypes.STRING(100), allowNull: false },
        email: { type: DataTypes.STRING(255), allowNull: false },
        passwordHash: { type: DataTypes.STRING(255), allowNull: false },
        status: {
          type: DataTypes.STRING(20),
          allowNull: false,
          defaultValue: 'ACTIVE',
          validate: { isIn: [USER_STATUSES] },
        },
      },
      {
        sequelize,
        modelName: 'User',
        tableName: 'users',
        underscored: true,
        defaultScope: { attributes: { exclude: ['passwordHash'] } },
      }
    );
  }

  static associate({ Queue }) {
    User.hasMany(Queue, { foreignKey: 'userId', as: 'queues' });
  }
}
