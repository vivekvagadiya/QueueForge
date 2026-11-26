# QueueForge — Sprint-wise Integration Roadmap

> **Goal:** Build QueueForge as a production-minded distributed job queue in small, verifiable sprints.
>
> **Architecture baseline:** Node.js + Express, Sequelize/Umzug, PostgreSQL as the source of truth, Redis Streams for job delivery, separate API and worker processes, and React dashboard later.
>
> **Implementation rule:** Finish the acceptance criteria of a sprint before moving to the next. Keep configuration values adjustable and validate them with tests.

## Current progress

- [x] PostgreSQL installed and `queueforge` database created.
- [x] API can connect to PostgreSQL through Sequelize (`SELECT 1+1` smoke test passed).
- [x] Redis and Docker setup/basic commands verified.
- [x] Umzug installed.
- [x] Migration runner and first migration implemented.
- [x] Five-table schema migrated and verified.
- [ ] API job lifecycle integrated with Redis Streams and workers.

**Immediate next step:** Sprint 2 — Redis Streams and the transactional outbox.

### Schema notes (Sprint 0)
- Migrations live in `backend/api/src/database/migrations/`; applied migrations are tracked in `schema_migrations`.
- `jobs` already includes the lease/fencing columns (`locked_by`, `lock_expires_at`, `lease_version`) and `idempotency_key` (unique per queue when not null), so Sprints 1 and 3 need no schema change.
- `jobs.locked_by` has no foreign key on purpose: a lease must remain recoverable even if the worker row is cleaned up.
- Status columns use `VARCHAR` + `CHECK` constraints rather than PostgreSQL enum types, which are easier to change in later migrations.
- `job_attempts.lease_version` records the fencing token each attempt ran under.

## Agreed MVP database schema

| Table | Purpose | Key relationships |
|---|---|---|
| `users` | Application users / queue owners | One user can own multiple queues |
| `queues` | Queue configuration and state | Belongs to `users`; has many jobs |
| `jobs` | Persisted job payload, status, schedule, and result | Belongs to `queues`; has many attempts |
| `workers` | Worker process registration and heartbeat | Has many job attempts |
| `job_attempts` | Per-execution history, result, and error details | Belongs to `jobs`; optionally references `workers` |

Keep `job_attempts.worker_id` nullable so an attempt can still be recorded when worker attribution is unavailable (for example, during certain recovery paths). Use UUID identifiers, PostgreSQL-native types such as `JSONB` where appropriate, timestamps, foreign keys, unique constraints, and indexes matching the agreed schema.

---

## Sprint 0 — Database foundation

**Goal:** Make schema creation repeatable and safe.

### Tasks
- [x] Create `src/database/migrate.js` using Umzug.
- [x] Configure Sequelize storage/context and migration discovery.
- [x] Add `db:migrate`, `db:migrate:undo`, and status/list scripts as appropriate.
- [x] Create migration `create-users-table`.
- [x] Create the remaining migrations in dependency order: `queues`, `jobs`, `workers`, `job_attempts`.
- [x] Add foreign keys, unique constraints, check constraints, and indexes from the agreed schema.
- [x] Add matching Sequelize models and associations.
- [x] Verify `up` against an empty database and `down` in reverse order.
- [x] Keep migration files as the source of truth; do not rely on `sequelize.sync()` for schema changes.

### Acceptance criteria
- [x] A fresh `queueforge` database can be migrated from zero using one command.
- [x] All five tables, constraints, indexes, and associations match the agreed schema.
- [x] Rollback works in reverse dependency order.
- [x] API startup fails clearly when the database is unavailable (also aborts when migrations are pending).

## Sprint 1 — API foundation and persistence

**Goal:** Implement the control-plane API and persist queues/jobs without Redis.

### Tasks
- [x] Organize modules: config, database, models, repositories, services, controllers, routes, middleware, validators, and errors.
- [x] Add centralized error handling and request validation with Zod.
- [x] Implement queue create/list/get/update operations.
- [x] Implement job submission and job retrieval endpoints.
- [x] Validate queue ownership and job input before persistence.
- [x] Add pagination and status filtering.
- [x] Add idempotency-key support backed by a database uniqueness constraint.
- [x] Add authentication/authorization before exposing user-owned resources.
- [x] Write integration tests against a test PostgreSQL database.

### Acceptance criteria
- [x] Queue and job CRUD flows work through HTTP.
- [x] Invalid requests return consistent validation errors.
- [x] A job cannot be submitted to a queue the caller does not own.
- [x] Duplicate idempotency keys do not create duplicate logical jobs.
- [x] API restart does not lose persisted jobs.

### API (Sprint 1)
All routes are under `/api/v1`. Everything except `auth/register` and `auth/login` requires `Authorization: Bearer <token>`.

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | `{ name, email, password }` → user + access token |
| POST | `/auth/login` | `{ email, password }` → user + access token |
| GET | `/auth/me` | Current user |
| POST | `/queues` | `{ name, description?, concurrency?, defaultJobOptions?: { maxAttempts?, priority? } }` |
| GET | `/queues` | `?page&limit&status=ACTIVE,PAUSED` |
| GET / PATCH | `/queues/:queueId` | PATCH accepts any create field plus `status`; `defaultJobOptions` is replaced whole |
| POST | `/queues/:queueId/jobs` | `{ name, payload?, priority?, maxAttempts?, delayMs? \| scheduledAt?, idempotencyKey? }`; the key may also be sent as the `Idempotency-Key` header |
| GET | `/queues/:queueId/jobs` | `?page&limit&status=WAITING,SCHEDULED` |
| GET | `/jobs/:jobId` | Job plus attempt history |

Behavior notes:
- Another user's queue or job returns `404`, the same as a missing one, so IDs don't reveal what exists.
- Idempotency keys are unique per queue. A replay returns `200` with the original job and `Idempotent-Replayed: true`. Reusing a key with a different `name` or `payload` returns `409 IDEMPOTENCY_KEY_CONFLICT`.
- `ARCHIVED` queues reject new jobs (`409`). `PAUSED` queues still accept them; pausing will only stop dispatch (Sprint 5).
- Errors always have the shape `{ success: false, error: { code, message, details? } }`.
- Tests: `npm test` runs the integration suite against `queueforge_test`, which is created automatically. Set `TEST_DATABASE_URL` to use a different database; its name must end in `_test`.

## Sprint 2 — Redis Streams and transactional outbox

**Goal:** Deliver job-ready events reliably after the database transaction commits.

### Tasks
- [ ] Add Redis client configuration, connection lifecycle, health checks, and bounded retry behavior.
- [ ] Add an `outbox_events` table only if/when the MVP schema is deliberately extended; document and migrate that schema change rather than silently adding it.
- [ ] Persist job creation and its outbox event in one PostgreSQL transaction.
- [ ] Implement an outbox publisher that safely claims pending events.
- [ ] Publish lightweight job-ready events with `XADD`.
- [ ] Mark events published only after Redis confirms the write.
- [ ] Make duplicate publication safe; a crash between `XADD` and marking published can produce duplicates.
- [ ] Add structured logs and retry/backoff for publisher failures.

### Acceptance criteria
- [ ] A committed job eventually produces a Redis Stream entry.
- [ ] Redis downtime does not lose a committed job.
- [ ] Publisher restart resumes pending publication.
- [ ] Duplicate stream events are safe to consume.

## Sprint 3 — Worker runtime and atomic job claiming

**Goal:** Execute handlers without allowing two workers to own the same job simultaneously.

### Tasks
- [ ] Create a separately runnable worker process from the same codebase.
- [ ] Define a job-handler registry and handler contract.
- [ ] Consume Redis Stream entries with `XREADGROUP` and a consumer group.
- [ ] Claim a job atomically in PostgreSQL before executing it.
- [ ] Persist worker ownership and a lease/fencing token as part of the agreed schema evolution.
- [ ] Create a `job_attempts` row in the same transaction as a successful claim.
- [ ] Execute handlers outside the database transaction.
- [ ] Persist success/failure with guarded updates using job ID, worker ID, and fencing token.
- [ ] Call `XACK` only after the durable database outcome commits.

### Acceptance criteria
- [ ] Two workers receiving the same event cannot execute the same eligible job concurrently.
- [ ] A worker that fails to claim a job never executes its handler.
- [ ] A database failure does not cause premature acknowledgement.
- [ ] Delivery semantics are documented as at-least-once; handlers are expected to be idempotent.

## Sprint 4 — Retry policy, leases, heartbeat, and recovery

**Goal:** Recover from worker crashes and transient handler failures.

### Tasks
- [ ] Add configurable maximum attempts and retryable/non-retryable error classification.
- [ ] Implement exponential backoff with jitter.
- [ ] Add job lease renewal using PostgreSQL time.
- [ ] Reject state updates from workers with stale ownership/fencing tokens.
- [ ] Implement worker heartbeat and worker status transitions.
- [ ] Recover jobs whose execution leases have expired.
- [ ] Preserve interrupted attempt history and transition jobs to retry or terminal state.
- [ ] Handle stale Redis pending entries with `XPENDING` / `XAUTOCLAIM` where appropriate.
- [ ] Add graceful worker shutdown and bounded draining.
- [ ] Test crash windows: before claim, during execution, after DB completion but before `XACK`, and during recovery.

### Acceptance criteria
- [ ] Expired jobs are recovered without stale workers overwriting newer state.
- [ ] Attempt history is retained.
- [ ] Retry exhaustion reaches a terminal state.
- [ ] Shutdown stops new consumption and handles in-flight work safely.

## Sprint 5 — Scheduling and queue controls

**Goal:** Add time-based execution and operational controls.

### Tasks
- [ ] Implement delayed/scheduled job release.
- [ ] Add queue pause/resume.
- [ ] Add job cancellation; running cancellation must be cooperative.
- [ ] Enforce worker and queue concurrency limits.
- [ ] Add rate limiting if required by the MVP.
- [ ] Define retention/cleanup for completed jobs and old attempts.

### Acceptance criteria
- [ ] Scheduled jobs become eligible at the correct time.
- [ ] Paused queues do not dispatch new work.
- [ ] Concurrency limits hold across multiple worker processes.
- [ ] Running cancellation does not falsely report a job as stopped while its handler is still executing.

## Sprint 6 — Dashboard and real-time visibility

**Goal:** Expose queue operations and job execution status.

### Tasks
- [ ] Build React dashboard pages for queues, jobs, attempts, and workers.
- [ ] Add Socket.IO updates for job and worker state changes.
- [ ] Persist state first, then emit real-time events.
- [ ] Ensure dashboard data can always be reloaded from API/PostgreSQL.
- [ ] Add search, filters, pagination, and useful empty/error states.

### Acceptance criteria
- [ ] Users can inspect queues, jobs, attempts, and worker health.
- [ ] Refreshing the dashboard restores the same persisted state.
- [ ] Socket.IO is an enhancement, not the source of truth.

## Sprint 7 — Observability, testing, and production hardening

**Goal:** Validate correctness under failure and load.

### Tasks
- [ ] Add structured logs and correlation IDs across API, publisher, and worker.
- [ ] Add metrics for queue depth, waiting age, execution duration, retries, failures, worker utilization, and publisher lag.
- [ ] Add health/readiness endpoints.
- [ ] Add unit, integration, end-to-end, race, and fault-injection tests.
- [ ] Load-test throughput, latency, recovery time, and database connection usage.
- [ ] Inspect critical queries with `EXPLAIN (ANALYZE, BUFFERS)` and tune indexes from measured plans.
- [ ] Add Docker Compose services for API, publisher, scheduler, recovery, workers, PostgreSQL, and Redis.
- [ ] Add CI checks for linting, tests, and migration validation.
- [ ] Document environment variables, setup, migrations, deployment, backup/restore, and recovery runbooks.

### Acceptance criteria
- [ ] A clean environment can be started from documented instructions.
- [ ] CI passes against a fresh database.
- [ ] Failure and load-test results are recorded.
- [ ] Deployment and recovery procedures are reproducible.

---

## Recommended next-session checklist

1. [ ] Decide whether to add the `outbox_events` table (a deliberate schema extension), and write its migration.
2. [ ] Write the job row and its outbox event in one transaction. With the insert inside a transaction, use `INSERT … ON CONFLICT` or a savepoint for idempotency races instead of catching the unique violation.
3. [ ] Add Redis connection lifecycle, health check, and bounded retry.
4. [ ] Build the outbox publisher process (`FOR UPDATE SKIP LOCKED` claim → `XADD` → mark published).
5. [ ] Add a migration up/down test to the test suite for CI.

## Definition of done for each sprint

- [ ] Relevant automated tests pass.
- [ ] Database changes are represented by migrations.
- [ ] Authorization and ownership checks are enforced server-side.
- [ ] Errors and logs are actionable and do not expose secrets.
- [ ] Documentation is updated when setup or behavior changes.
- [ ] Acceptance criteria are demonstrated locally.

## Architecture invariants

- PostgreSQL is the source of truth for persisted job state.
- Redis Streams transports work notifications; a stream entry does not grant execution ownership.
- Delivery is at-least-once, not exactly-once.
- Persist durable state before acknowledging a Redis stream entry.
- Use atomic claims and lease/fencing checks to prevent stale or concurrent workers from corrupting job state.
- Keep API and worker process roles independently runnable while sharing one codebase initially.
