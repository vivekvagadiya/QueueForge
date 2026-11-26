import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Sequelize } from 'sequelize';
import { Umzug, SequelizeStorage } from 'umzug';
import { logger } from '../config/logger.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Builds an Umzug instance bound to the given Sequelize connection.
 * Migration files are ESM modules exporting `up` and `down`, each receiving
 * `{ context: { queryInterface, Sequelize } }`.
 */
export const createMigrator = (sequelize) =>
  new Umzug({
    migrations: {
      // tinyglobby expects forward slashes, including on Windows.
      glob: path.join(migrationsDir, '*.js').replace(/\\/g, '/'),
      // The package is ESM, so load migrations with import() instead of require().
      resolve: ({ name, path: filePath, context }) => ({
        name,
        up: async () => (await import(pathToFileURL(filePath).href)).up(context),
        down: async () => (await import(pathToFileURL(filePath).href)).down(context),
      }),
    },
    context: { queryInterface: sequelize.getQueryInterface(), Sequelize },
    storage: new SequelizeStorage({ sequelize, tableName: 'schema_migrations' }),
    logger: {
      info: (event) => logger.info(event, 'migration'),
      warn: (event) => logger.warn(event, 'migration'),
      error: (event) => logger.error(event, 'migration'),
      debug: (event) => logger.debug(event, 'migration'),
    },
  });
