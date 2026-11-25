import { Sequelize } from 'sequelize';
import { env } from './env.js';
import { logger } from './logger.js';

let sequelizeInstance = null;

export const getDatabase = () => {
  if (sequelizeInstance) {
    return sequelizeInstance;
  }

  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }

  sequelizeInstance = new Sequelize(env.DATABASE_URL, {
    dialect: 'postgres',
    logging: (message) => logger.debug({ sequelize: message }, 'Database query'),
  });

  return sequelizeInstance;
};

export const closeDatabase = async () => {
  if (!sequelizeInstance) {
    return;
  }

  await sequelizeInstance.close();
  sequelizeInstance = null;
  logger.info('PostgreSQL connection closed');
};
