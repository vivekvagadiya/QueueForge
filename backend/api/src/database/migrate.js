import { getDatabase, closeDatabase } from '../config/database.js';
import { createMigrator } from './umzug.js';

/**
 * Migration CLI. Examples:
 *   node src/database/migrate.js up             apply all pending migrations
 *   node src/database/migrate.js down           revert the last migration
 *   node src/database/migrate.js down --to 0    revert all migrations
 *   node src/database/migrate.js pending        list pending migrations
 *   node src/database/migrate.js executed       list applied migrations
 */
const run = async () => {
  const sequelize = getDatabase();
  let exitCode = 0;

  try {
    await sequelize.authenticate();
    await createMigrator(sequelize).runAsCLI();
  } catch (err) {
    console.error(`[QueueForge migrate] ${err.message}`);
    if (err.cause) {
      console.error(`  cause: ${err.cause.message ?? err.cause}`);
    }
    exitCode = 1;
  } finally {
    await closeDatabase();
  }

  process.exit(exitCode);
};

run();
