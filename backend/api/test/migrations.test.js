import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getDatabase } from '../src/config/database.js';
import { createMigrator } from '../src/database/umzug.js';
import { setupDatabase, teardownDatabase } from './helpers.js';

const EXPECTED_TABLES = ['job_attempts', 'jobs', 'outbox_events', 'queues', 'users', 'workers'];

// Uses pg_tables: Sequelize rewrites the result of queries on
// information_schema.tables into a flat list, which breaks row destructuring.
const appTables = async () => {
  const [rows] = await getDatabase().query(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
     ORDER BY tablename`
  );
  return rows.map((r) => r.tablename);
};

before(setupDatabase);
after(teardownDatabase);

test('migrations roll back to empty and re-apply cleanly', async () => {
  const migrator = createMigrator(getDatabase());
  assert.deepEqual(await appTables(), EXPECTED_TABLES);

  // Reverse dependency order must succeed without FK errors.
  await migrator.down({ to: 0 });
  assert.deepEqual(await appTables(), []);
  assert.equal((await migrator.executed()).length, 0);

  await migrator.up();
  assert.deepEqual(await appTables(), EXPECTED_TABLES);
  assert.equal((await migrator.pending()).length, 0);
});
