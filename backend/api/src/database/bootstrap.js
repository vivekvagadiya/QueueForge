import { closeDatabase, getDatabase } from '../config/database.js';
import { logger } from '../config/logger.js';
import { initModels } from '../models/index.js';
import { createMigrator } from './umzug.js';

/**
 * Verifies PostgreSQL is reachable and fully migrated, then registers models.
 * Exits the process with a clear message otherwise; every runtime role (API,
 * publisher, later workers) calls this before doing any work.
 */
export const initDatabase = async (role) => {
  const fail = async (logMessage, consoleMessage, fields) => {
    logger.fatal(fields, logMessage);
    console.error(`[QueueForge ${role}] Startup aborted: ${consoleMessage}`);
    await closeDatabase();
    process.exit(1);
  };

  const sequelize = getDatabase();

  try {
    await sequelize.authenticate();
  } catch (err) {
    await fail(
      'Cannot connect to PostgreSQL',
      `cannot connect to PostgreSQL (${err.original?.code ?? err.message}). ` +
        'Check DATABASE_URL and that the database server is running.',
      { err: err.original ?? err }
    );
  }

  const pending = await createMigrator(sequelize).pending();
  if (pending.length > 0) {
    const names = pending.map((m) => m.name);
    await fail(
      'Database has pending migrations',
      `${pending.length} pending migration(s): ${names.join(', ')}. Run \`npm run db:migrate\`.`,
      { pending: names }
    );
  }

  initModels(sequelize);
  logger.info({ role }, 'PostgreSQL connected and schema up to date');
};
