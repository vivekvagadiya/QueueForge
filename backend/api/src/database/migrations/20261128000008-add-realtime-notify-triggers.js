/**
 * Sprint 6C: real-time change notifications.
 *
 * Triggers on jobs, queues and workers call pg_notify('queueforge_events', ...).
 * PostgreSQL delivers a NOTIFY only when the transaction that sent it commits,
 * and drops it on rollback, so listeners (the API's Socket.IO relay) can only
 * ever hear about committed state, whichever process made the change: API,
 * worker, recovery or publisher. Payloads are small invalidation hints (IDs
 * and status); clients reload the data itself from the API.
 *
 * Only meaningful changes notify: job status / cancel request, any queue
 * change, worker status / active job count. Lease renewals and heartbeats
 * do not.
 */
const CHANNEL = 'queueforge_events';

export const up = async ({ queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `CREATE OR REPLACE FUNCTION queueforge_notify_job() RETURNS trigger AS $$
       DECLARE owner_id uuid;
       BEGIN
         SELECT user_id INTO owner_id FROM queues WHERE id = NEW.queue_id;
         PERFORM pg_notify('${CHANNEL}', json_build_object(
           'type', 'job', 'id', NEW.id, 'queueId', NEW.queue_id, 'userId', owner_id,
           'status', NEW.status)::text);
         RETURN NULL;
       END $$ LANGUAGE plpgsql;

       CREATE OR REPLACE FUNCTION queueforge_notify_queue() RETURNS trigger AS $$
       BEGIN
         PERFORM pg_notify('${CHANNEL}', json_build_object(
           'type', 'queue', 'id', NEW.id, 'userId', NEW.user_id, 'status', NEW.status)::text);
         RETURN NULL;
       END $$ LANGUAGE plpgsql;

       CREATE OR REPLACE FUNCTION queueforge_notify_worker() RETURNS trigger AS $$
       BEGIN
         PERFORM pg_notify('${CHANNEL}', json_build_object(
           'type', 'worker', 'id', NEW.id, 'status', NEW.status, 'activeJobs', NEW.active_jobs)::text);
         RETURN NULL;
       END $$ LANGUAGE plpgsql;

       CREATE TRIGGER jobs_notify_insert AFTER INSERT ON jobs
         FOR EACH ROW EXECUTE FUNCTION queueforge_notify_job();
       CREATE TRIGGER jobs_notify_update AFTER UPDATE OF status, cancel_requested_at ON jobs
         FOR EACH ROW
         WHEN (OLD.status IS DISTINCT FROM NEW.status
               OR OLD.cancel_requested_at IS DISTINCT FROM NEW.cancel_requested_at)
         EXECUTE FUNCTION queueforge_notify_job();

       CREATE TRIGGER queues_notify AFTER INSERT OR UPDATE ON queues
         FOR EACH ROW EXECUTE FUNCTION queueforge_notify_queue();

       CREATE TRIGGER workers_notify_insert AFTER INSERT ON workers
         FOR EACH ROW EXECUTE FUNCTION queueforge_notify_worker();
       CREATE TRIGGER workers_notify_update AFTER UPDATE OF status, active_jobs ON workers
         FOR EACH ROW
         WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.active_jobs IS DISTINCT FROM NEW.active_jobs)
         EXECUTE FUNCTION queueforge_notify_worker();`,
      { transaction }
    );
  });
};

export const down = async ({ queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `DROP TRIGGER IF EXISTS workers_notify_update ON workers;
       DROP TRIGGER IF EXISTS workers_notify_insert ON workers;
       DROP TRIGGER IF EXISTS queues_notify ON queues;
       DROP TRIGGER IF EXISTS jobs_notify_update ON jobs;
       DROP TRIGGER IF EXISTS jobs_notify_insert ON jobs;
       DROP FUNCTION IF EXISTS queueforge_notify_worker();
       DROP FUNCTION IF EXISTS queueforge_notify_queue();
       DROP FUNCTION IF EXISTS queueforge_notify_job();`,
      { transaction }
    );
  });
};
