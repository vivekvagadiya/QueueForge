# QueueForge — Operations Guide

How to set up, run, deploy, back up and recover QueueForge.

Architecture summary:
- **PostgreSQL** is the source of truth for queues, jobs, attempts, workers and the outbox.
- **Redis Streams** only carries "job ready" notifications. Losing Redis loses no job, only notifications, which can be re-sent (see [Redis data lost](#redis-data-lost)).
- **Processes:**
  - **API:** HTTP and Socket.IO.
  - **Publisher:** moves outbox events to Redis.
  - **Worker:** runs jobs; scale it to as many instances as you need.
  - **Recovery:** releases scheduled jobs and retries, recovers expired leases, and runs retention.

  All four run from one backend image. Each can run as several instances.

---

## 1. Environment variables

The backend reads its settings from the environment, or from `backend/api/.env` (see `backend/api/.env.example`). They are validated at startup, and a process with invalid settings exits with a message naming the variable. An empty value counts as unset.

### Core

| Variable | Default | Used by | Notes |
|---|---|---|---|
| `NODE_ENV` | `development` | all | `development`, `test` or `production` |
| `PORT` | `4000` | API | HTTP and Socket.IO |
| `LOG_LEVEL` | `info` | all | `fatal` … `trace`, or `silent` |
| `DATABASE_URL` | — | all | Required. PostgreSQL 13 or later (uses `gen_random_uuid()`) |
| `REDIS_URL` | — | all but the API | Required for the publisher and workers. The API uses it only for its readiness report |
| `CORS_ORIGIN` | `http://localhost:5173` | API | Comma-separated list, or `*` |
| `JWT_SECRET` | — | all | Required, at least 32 characters. Changing it signs everyone out |
| `JWT_EXPIRES_IN` / `JWT_ISSUER` | `1h` / `queueforge-api` | API | |
| `STREAM_PREFIX` | `queueforge` | all | Stream keys are `<prefix>:queue:<queueId>:jobs` |

### Publisher

| Variable | Default | Notes |
|---|---|---|
| `OUTBOX_POLL_INTERVAL_MS` | `1000` | Idle polling interval; a full batch polls again immediately |
| `OUTBOX_BATCH_SIZE` | `100` | |
| `OUTBOX_CLAIM_TIMEOUT_MS` | `30000` | A claim older than this is taken over (the publisher is assumed to have crashed) |
| `OUTBOX_RETRY_BASE_MS` / `OUTBOX_RETRY_MAX_MS` | `1000` / `60000` | Backoff after a failed publish |

### Worker

| Variable | Default | Notes |
|---|---|---|
| `WORKER_NAME` | `worker-<host>-<pid>` | Display name |
| `CONSUMER_GROUP` | `queueforge-workers` | All workers must share it |
| `WORKER_QUEUES` | `*` | `*`, or comma-separated queue UUIDs |
| `WORKER_CONCURRENCY` | `5` | Jobs at once per worker process |
| `WORKER_LEASE_MS` | `30000` | Job lease. Renewed every `WORKER_LEASE_RENEW_MS` (default lease ÷ 3) |
| `WORKER_HEARTBEAT_MS` | `5000` | Must be shorter than `WORKER_HEARTBEAT_TIMEOUT_MS` |
| `WORKER_SHUTDOWN_GRACE_MS` | `20000` | Time running jobs get to finish on SIGTERM |
| `WORKER_BLOCK_MS`, `WORKER_QUEUE_REFRESH_MS`, `WORKER_PENDING_IDLE_MS`, `WORKER_PENDING_CHECK_MS`, `WORKER_CANCEL_CHECK_MS`, `WORKER_CAPACITY_RETRY_BASE_MS`, `WORKER_CAPACITY_RETRY_MAX_MS` | see `.env.example` | Tuning |
| `JOB_RETRY_BASE_MS` / `JOB_RETRY_MAX_MS` | `1000` / `300000` | Retry backoff for failed attempts (also used by recovery) |

### Recovery and retention

| Variable | Default | Notes |
|---|---|---|
| `RECOVERY_INTERVAL_MS` / `RECOVERY_BATCH_SIZE` | `1000` / `100` | |
| `WORKER_HEARTBEAT_TIMEOUT_MS` | `30000` | Silent workers are marked `UNHEALTHY` |
| `RETENTION_INTERVAL_MS` / `RETENTION_BATCH_SIZE` | `60000` / `1000` | |
| `JOB_RETENTION_COMPLETED_MS` | 7 days | `0` keeps rows forever |
| `JOB_RETENTION_FAILED_MS` | 30 days | Applies to FAILED, DEAD and CANCELLED jobs |
| `OUTBOX_RETENTION_MS` | 1 day | Published outbox rows |
| `STREAM_RETENTION_MS` | 1 hour | Acknowledged stream entries; pending entries are never trimmed |
| `STREAM_CONSUMER_RETENTION_MS` | 1 day | Idle consumers of stopped workers |

### Observability

| Variable | Default | Notes |
|---|---|---|
| `OPS_PORT` / `OPS_HOST` | unset / `0.0.0.0` | Health and metrics server for the publisher, workers and recovery. Unset turns it off |
| `METRICS_TOKEN` | unset | When set (16+ characters), `/metrics` requires `Authorization: Bearer <token>` |
| `METRICS_CACHE_MS` | `5000` | How long the API reuses its PostgreSQL snapshot for cluster gauges |
| `HEALTH_CHECK_TIMEOUT_MS` | `2000` | Per dependency check |

### Frontend (build time)

| Variable | Notes |
|---|---|
| `VITE_API_BASE_URL` | `/api/v1` when served from the same origin as the API (Vite proxy or nginx); otherwise the API's full URL |
| `VITE_API_PROXY_TARGET` | Where the Vite dev server forwards `/api` and `/socket.io`. Required by `vite.config.js` |

### Docker Compose (`./.env`, see `./.env.example`)

`JWT_SECRET` (required), `POSTGRES_PASSWORD`, `METRICS_TOKEN`, `LOG_LEVEL`, `WORKER_REPLICAS`, `WORKER_CONCURRENCY`, `FRONTEND_PORT` (8080), `API_PORT` (4000), `POSTGRES_PORT` (5433), `CORS_ORIGIN`.

---

## 2. Setup

### A. Full stack in Docker (fastest)

Requires Docker with Compose v2.

```bash
cp .env.example .env          # then set JWT_SECRET (and POSTGRES_PASSWORD)
docker compose --profile full up -d --build
docker compose --profile full ps    # wait until everything is "healthy"
```

| Service | Role |
|---|---|
| `postgres` | PostgreSQL 17. Published on host port 5433 so it doesn't clash with a local server |
| `redis` | Redis 7 with AOF persistence |
| `migrate` | One-shot: applies migrations, then exits. Everything else waits for it |
| `api` | Port 4000 |
| `publisher`, `recovery` | One each |
| `worker` | `WORKER_REPLICAS` copies, 2 by default |
| `frontend` | Dashboard at http://localhost:8080. Its nginx proxies `/api` and `/socket.io` to the API, so the browser sees one origin |

**Useful commands**
- Logs: `docker compose logs -f api worker`. Every line is JSON with `role` and `correlationId`.
- More workers: `docker compose --profile full up -d --scale worker=4`.
- Stop: `docker compose --profile full down`. Data stays in the `pg_data` and `redis_data` volumes; `down -v` deletes it.

### B. Local development

1. **Redis:** `docker compose up -d`. Without a profile this starts Redis only.
2. **PostgreSQL:** create a `queueforge` database on your local server.
3. **Backend:**
   ```bash
   cd backend/api
   cp .env.example .env      # set DATABASE_URL and JWT_SECRET
   npm install
   npm run db:migrate
   ```
   Then start each process in its own terminal: `npm run dev`, `npm run dev:publisher`, `npm run dev:worker` and `npm run dev:recovery`.
4. **Frontend:**
   ```bash
   cd frontend
   cp .env.example .env
   npm install
   npm run dev               # http://localhost:5173
   ```

---

## 3. Migrations

- Migrations are in `backend/api/src/database/migrations/`; applied ones are recorded in `schema_migrations`.
- Every process refuses to start while a migration is pending. Migrations never run automatically inside the app.

| Command (in `backend/api`) | Effect |
|---|---|
| `npm run db:migrate` | Apply all pending migrations |
| `npm run db:migrate:pending` / `db:migrate:status` | List pending / applied migrations |
| `npm run db:migrate:undo` | Revert the last migration |
| `npm run db:migrate:undo:all` | Revert everything. **This drops all data** |

**In Docker**, the `migrate` service runs `up` on every `docker compose up`. To run it by hand: `docker compose --profile full run --rm migrate`.

**Deploying a migration**
1. Back up the database (see section 5).
2. Run migrations.
3. Roll out the new image.

New migrations must work with the code that is already running. Add columns as nullable, and remove them only in a later release.

**CI** applies every migration to a fresh database, rolls them all back, and applies them again.

---

## 4. Deployment

The backend image is built from `backend/api/Dockerfile`. The `command` selects the process:

| Process | Command | Instances | Health (readiness) |
|---|---|---|---|
| Migrations | `node src/database/migrate.js up` | One-shot, before each rollout | Exit code |
| API | `node src/server.js` | 1 or more, behind a load balancer | `GET :4000/api/v1/health/ready` |
| Publisher | `node src/publisher.js` | 1 or more | `GET :$OPS_PORT/health/ready` |
| Worker | `node src/worker.js` | Any number | `GET :$OPS_PORT/health/ready` |
| Recovery | `node src/recovery.js` | 1 or more (all steps are safe to run concurrently) | `GET :$OPS_PORT/health/ready` |
| Dashboard | `frontend/Dockerfile` (nginx) | Any number | `GET :8080/` |

**Health probes**
- Use `/health/live` for liveness (restart) probes. It never checks dependencies.
- Use `/health/ready` for readiness and traffic. It returns `503` while a critical dependency is down or the process is shutting down.

**Rollout order**
1. Migrations.
2. API, publisher, recovery.
3. Workers.

**Stopping processes**
- Send SIGTERM and allow enough time:
  - Workers need more than `WORKER_SHUTDOWN_GRACE_MS` plus about 10 s. Compose uses 35 s.
  - The other processes need 15 s.
- A worker stops reading new work, finishes or hands back the jobs it is running, and marks itself `STOPPED`.
- If a process is killed anyway, nothing is lost: expired leases are recovered by the recovery process, and unacknowledged stream entries are taken over by other workers.

**Metrics**
- Scrape `/metrics` on every process.
- Scrape at least one API instance for the cluster gauges: queue depth, waiting age, utilization and outbox lag.
- Set `METRICS_TOKEN`, or keep `/metrics` on a private network.

**Behind a reverse proxy**
- Forward `/socket.io` with WebSocket upgrade headers.
- Pass or generate `X-Request-Id`.

`frontend/nginx.conf` is a working example.

**Security checklist**
- [ ] Use a unique `JWT_SECRET` and a strong `POSTGRES_PASSWORD`. Don't publish PostgreSQL or Redis ports outside the private network.
- [ ] Restrict `CORS_ORIGIN` to the dashboard's origin.
- [ ] Set `METRICS_TOKEN`, or firewall `/metrics` and the ops ports.
- [ ] Use TLS at the load balancer.

---

## 5. Backup and restore

**Only PostgreSQL needs backing up.** Redis holds delivery notifications that can be regenerated from PostgreSQL. Its AOF file (`redis_data` volume) only shortens recovery.

### Back up

```bash
# Docker Compose
docker compose --profile full exec -T postgres \
  pg_dump -U queueforge -d queueforge -Fc > queueforge-$(date +%F).dump

# Any server
pg_dump "$DATABASE_URL" -Fc -f queueforge-$(date +%F).dump
```

- `-Fc` (custom format) is compressed and can be restored selectively.
- Schedule it at least daily. Keep copies off the host.
- Test a restore regularly.
- For point-in-time recovery, use WAL archiving or your provider's PITR.

### Restore

1. Stop every process that writes:
   ```bash
   docker compose --profile full stop api publisher worker recovery
   ```
2. Restore into a clean database:
   ```bash
   docker compose --profile full exec -T postgres \
     dropdb -U queueforge --if-exists queueforge
   docker compose --profile full exec -T postgres \
     createdb -U queueforge queueforge
   docker compose --profile full exec -T postgres \
     pg_restore -U queueforge -d queueforge --no-owner < queueforge-YYYY-MM-DD.dump
   ```
3. Apply any newer migrations:
   ```bash
   docker compose --profile full run --rm migrate
   ```
4. Re-send notifications for waiting jobs, using the SQL under [Redis data lost](#redis-data-lost). Stream entries written after the backup refer to jobs that no longer exist or have changed; workers recognise and discard them.
5. Start the processes again:
   ```bash
   docker compose --profile full up -d
   ```
   Jobs that were `ACTIVE` in the backup have expired leases, so recovery moves them to `RETRYING`, or `DEAD` once they're out of attempts.

---

## 6. Recovery runbooks

Each entry: symptom → check → action. Search the logs by `correlationId`. It is in every API error response as `error.requestId`, and it follows a job from its submit request to the worker that ran it.

### Jobs stay WAITING and never start

- **Check**
  - Is the queue `PAUSED`, or at its `concurrency` limit? The `queueforge_queue_jobs{status="ACTIVE"}` gauge shows the second.
  - Are any workers serving it? Look at `queueforge_workers{status="RUNNING"}`, and at `WORKER_QUEUES`.
  - Is the publisher behind? Look at `queueforge_outbox_oldest_unpublished_age_seconds`.
- **Action**
  - Resume the queue or raise its concurrency.
  - Start workers.
  - If the outbox is empty but jobs are still waiting, the notifications were lost: see [Redis data lost](#redis-data-lost).

### Publisher lag growing (`queueforge_outbox_oldest_unpublished_age_seconds` rising)

- **Check**
  - Publisher readiness: `redis` down?
  - Publisher logs: "Outbox publish failed" with `retryInMs`?
  - Is `queueforge_outbox_events{status="PENDING"}` growing?
- **Action**
  - Fix Redis connectivity. Events stay `PENDING` meanwhile, and none are lost.
  - Add publisher instances. They claim disjoint batches.
  - Raise `OUTBOX_BATCH_SIZE` if events are piling up because each cycle publishes too few.

### Redis data lost

Redis was flushed, its volume was lost, or PostgreSQL was restored.

PostgreSQL still has every job, but stream entries for `WAITING` jobs are gone. Re-announce them; duplicates are harmless, because only the claim in PostgreSQL decides what runs.

```sql
INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, correlation_id)
SELECT 'job', id, 'job.ready', jsonb_build_object('jobId', id, 'queueId', queue_id), 'runbook-reannounce'
FROM jobs
WHERE status = 'WAITING';
```

- **Running the SQL:** in Docker, use `docker compose --profile full exec postgres psql -U queueforge -d queueforge`.
- **Single queue:** pausing and resuming it does the same thing.
- **Afterwards:** consumer groups are recreated automatically, and jobs in other statuses are handled by recovery as usual.

### Jobs stuck ACTIVE

- **Check**
  - Find the job's lease:
    ```sql
    SELECT id, locked_by, lock_expires_at FROM jobs WHERE status = 'ACTIVE';
    ```
  - Is the recovery process running and ready?
- **Action**
  - If the lease has expired and recovery is ready, the job is released on its next pass (about 1 s).
  - If the lease keeps being renewed, a handler is hung. Cancel the job (`POST /jobs/:id/cancel`), or restart that worker. On shutdown it hands the job back as INTERRUPTED.
  - Never edit lease columns by hand.

### Worker marked UNHEALTHY

- **Meaning:** no heartbeat for `WORKER_HEARTBEAT_TIMEOUT_MS`. Its jobs are safe: their leases expire and recovery reassigns them.
- **Check:** the worker's readiness (`/health/ready`) and logs. Look for database or Redis errors.
- **Action:** restart it. A worker that comes back reports `RUNNING` on its next heartbeat.

### Many DEAD or FAILED jobs

- **Check**
  - Look at `queueforge_job_attempts_total{outcome=~"dead|failed|retrying"}` by `queue_id`.
  - Open a job in the dashboard to see each attempt's error code and message.
- **Action**
  - Fix the handler or its downstream dependency.
  - DEAD jobs are not retried automatically. Resubmit them as new jobs, without an idempotency key or with a new one: reusing the original key returns the existing DEAD job.

### Database unavailable

- **What happens**
  - The API returns `503 SERVICE_UNAVAILABLE`, and every process reports not ready.
  - Workers leave stream entries unacknowledged, and running jobs keep their leases until renewal fails for a full lease period, then abort.
- **Action:** restore the database. Nothing needs re-sending.

### Redis unavailable

- **What happens**
  - The API keeps working, and its readiness shows `degraded`.
  - Outbox events stay `PENDING` and are published when Redis returns.
  - Workers wait.
- **Action:** if Redis lost its data, run the re-announce SQL above.
