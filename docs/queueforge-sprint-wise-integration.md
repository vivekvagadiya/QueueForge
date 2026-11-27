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
- [x] Transactional outbox and publisher deliver jobs to Redis Streams.
- [x] Workers consume streams and execute jobs.
- [x] Leases, heartbeat, retry release, and crash recovery.
- [x] Scheduled release, queue pause/resume, cooperative cancellation, queue concurrency limits, and retention.

**Immediate next step:** Sprint 6: React dashboard and real-time visibility.

### Schema notes (Sprint 0)
- Migrations live in `backend/api/src/database/migrations/`; applied migrations are tracked in `schema_migrations`.
- `jobs` already includes the lease/fencing columns (`locked_by`, `lock_expires_at`, `lease_version`) and `idempotency_key` (unique per queue when not null), so Sprints 1 and 3 need no schema change.
- `jobs.locked_by` has no foreign key on purpose: a lease must remain recoverable even if the worker row is cleaned up.
- Status columns use `VARCHAR` + `CHECK` constraints rather than PostgreSQL enum types, which are easier to change in later migrations.
- `job_attempts.lease_version` records the fencing token each attempt ran under.
- Sprint 5 migration `20261127000007` adds `jobs.cancel_requested_at` plus partial indexes for retention (terminal jobs by `completed_at`, published outbox rows by `published_at`) and for the worker's cancel poll.

## Agreed MVP database schema

| Table | Purpose | Key relationships |
|---|---|---|
| `users` | Application users / queue owners | One user can own multiple queues |
| `queues` | Queue configuration and state | Belongs to `users`; has many jobs |
| `jobs` | Persisted job payload, status, schedule, and result | Belongs to `queues`; has many attempts |
| `workers` | Worker process registration and heartbeat | Has many job attempts |
| `job_attempts` | Per-execution history, result, and error details | Belongs to `jobs`; optionally references `workers` |
| `outbox_events` | Transactional outbox (added deliberately in Sprint 2) | `aggregate_id` references a job; no FK, so events outlive job cleanup |

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
| GET | `/queues` | `?page&limit&status=ACTIVE,PAUSED&search=mail` (`search`: name contains, case-insensitive; Sprint 6A) |
| GET / PATCH | `/queues/:queueId` | PATCH accepts any create field plus `status`; `defaultJobOptions` is replaced whole |
| POST | `/queues/:queueId/pause` | Stop dispatching (Sprint 5). Idempotent; `409 QUEUE_ARCHIVED` for archived queues |
| POST | `/queues/:queueId/resume` | Resume dispatch and re-announce waiting jobs (Sprint 5). Idempotent; `409` for archived queues |
| POST | `/queues/:queueId/jobs` | `{ name, payload?, priority?, maxAttempts?, delayMs? \| scheduledAt?, idempotencyKey? }`; the key may also be sent as the `Idempotency-Key` header |
| GET | `/queues/:queueId/jobs` | `?page&limit&status=WAITING,SCHEDULED&search=` (`search`: name contains, or exact job ID; Sprint 6B) |
| GET | `/jobs/:jobId` | Job plus attempt history |
| GET | `/workers` | Sprint 6B. `?page&limit&status=RUNNING,UNHEALTHY`; read-only worker health, with `meta.statusCounts` |
| POST | `/jobs/:jobId/cancel` | Sprint 5. `200` when the job is cancelled, or `202` when a running job was asked to stop (it stays `ACTIVE`). `409 JOB_NOT_CANCELLABLE` once finished |

Behavior notes:
- Another user's queue or job returns `404`, the same as a missing one, so IDs don't reveal what exists.
- Idempotency keys are unique per queue. A replay returns `200` with the original job and `Idempotent-Replayed: true`. Reusing a key with a different `name` or `payload` returns `409 IDEMPOTENCY_KEY_CONFLICT`.
- `ARCHIVED` queues reject new jobs (`409`). `PAUSED` queues still accept them; pausing only stops dispatch.
- Errors always have the shape `{ success: false, error: { code, message, details? } }`.
- Tests: `npm test` runs the integration suite against `queueforge_test`, which is created automatically. Set `TEST_DATABASE_URL` to use a different database; its name must end in `_test`.

## Sprint 2 — Redis Streams and transactional outbox

**Goal:** Deliver job-ready events reliably after the database transaction commits.

### Tasks
- [x] Add Redis client configuration, connection lifecycle, health checks, and bounded retry behavior.
- [x] Add an `outbox_events` table only if/when the MVP schema is deliberately extended; document and migrate that schema change rather than silently adding it.
- [x] Persist job creation and its outbox event in one PostgreSQL transaction.
- [x] Implement an outbox publisher that safely claims pending events.
- [x] Publish lightweight job-ready events with `XADD`.
- [x] Mark events published only after Redis confirms the write.
- [x] Make duplicate publication safe; a crash between `XADD` and marking published can produce duplicates.
- [x] Add structured logs and retry/backoff for publisher failures.

### Acceptance criteria
- [x] A committed job eventually produces a Redis Stream entry.
- [x] Redis downtime does not lose a committed job (verified with a real Redis outage).
- [x] Publisher restart resumes pending publication.
- [x] Duplicate stream events are safe to consume. *Closed in Sprint 3: a duplicate entry fails the claim, so the handler doesn't run again, and the entry is acknowledged.*

### How it works (Sprint 2)
- Submitting a `WAITING` job inserts the job and a `job.ready` row in `outbox_events` in one transaction. `SCHEDULED` jobs get their event when the scheduler releases them (Sprint 5).
- Run the publisher with `npm run publisher`; several instances can run at once. Each cycle claims due events with `FOR UPDATE SKIP LOCKED`, sends each one with `XADD`, then marks the successful ones `PUBLISHED`. Failed events go back to `PENDING` with exponential backoff and jitter.
- While Redis is unreachable the publisher claims nothing, so attempt counts don't climb. A claim older than `OUTBOX_CLAIM_TIMEOUT_MS` is treated as abandoned by a crashed publisher and taken over. Every update after a claim checks `locked_by`.
- Streams: `<STREAM_PREFIX>:queue:<queueId>:jobs`, with entry fields `eventId`, `eventType`, `jobId`, `queueId`. The job payload is never copied to Redis.
- Stream trimming and cleanup of published outbox rows are handled by retention (Sprint 5).

## Sprint 3 — Worker runtime and atomic job claiming

**Goal:** Execute handlers without allowing two workers to own the same job simultaneously.

### Tasks
- [x] Create a separately runnable worker process from the same codebase.
- [x] Define a job-handler registry and handler contract.
- [x] Consume Redis Stream entries with `XREADGROUP` and a consumer group.
- [x] Claim a job atomically in PostgreSQL before executing it.
- [x] Persist worker ownership and a lease/fencing token as part of the agreed schema evolution.
- [x] Create a `job_attempts` row in the same transaction as a successful claim.
- [x] Execute handlers outside the database transaction.
- [x] Persist success/failure with guarded updates using job ID, worker ID, and fencing token.
- [x] Call `XACK` only after the durable database outcome commits.

### Acceptance criteria
- [x] Two workers receiving the same event cannot execute the same eligible job concurrently.
- [x] A worker that fails to claim a job never executes its handler.
- [x] A database failure does not cause premature acknowledgement.
- [x] Delivery semantics are documented as at-least-once; handlers are expected to be idempotent.

### How it works (Sprint 3)
- `npm run worker` registers the process in `workers`. That row's ID is both the lease owner (`jobs.locked_by`) and the consumer name (`worker:<id>`) in the `CONSUMER_GROUP`.
- `WORKER_QUEUES=*` consumes every non-archived queue and picks up new queues every `WORKER_QUEUE_REFRESH_MS`. Consumer groups start at ID `0`, so jobs published before any worker existed are still delivered.
- For each entry the worker: claims the job (`WAITING → ACTIVE`, `lease_version + 1`, `attempts_made + 1`, new `RUNNING` attempt row, all in one transaction) → runs the handler with no transaction open → saves the outcome. That write only applies if job ID, `locked_by`, `lease_version` and `status = ACTIVE` all still match → commits → `XACK`.
- **Handler contract** (see `src/worker/handlerRegistry.js`): `async ({ job, signal, logger }) => result`. The result must be JSON-serializable. Throw `NonRetryableError` to fail permanently. Register handlers in `src/worker/handlers/index.js`. Built-in demo handlers: `system.echo`, `system.sleep`, `system.fail`.
- **Delivery is at-least-once.** A handler can run more than once, for example after a crash between a side effect and saving the result. Handlers must be idempotent; pass `job.id` as the idempotency key to external providers.
- **Outcomes:**
  - Success → `COMPLETED`.
  - Retryable error with attempts left → `RETRYING`, with `scheduled_at` set by exponential backoff with jitter.
  - Last allowed attempt fails → `DEAD`.
  - `NonRetryableError`, unknown job name (`HANDLER_NOT_FOUND`), or a result that can't be serialized → `FAILED`.
- **Entries that can't be claimed are acknowledged without running anything.** That covers a finished job, an `ACTIVE`, `SCHEDULED` or `RETRYING` job, an unknown job, or a malformed entry. **Event policy:** every transition into `WAITING` must create a fresh `job.ready` outbox event. The scheduler, retry release and recovery in Sprints 4–5 must follow this rule.
- Database errors during the claim, the inspection, or the outcome write leave the entry **unacknowledged**.
- **Backpressure:** a worker reads only when it has a free slot. `XREADGROUP` `COUNT` applies per stream, so extra entries from one multi-stream read wait in a small local backlog, at most one per stream.
- **Shutdown:** the worker is marked `DRAINING`, stops reading, and finishes in-flight and already-delivered entries within `WORKER_SHUTDOWN_GRACE_MS`. It then aborts the rest and is marked `STOPPED`. *(Sprint 4: aborted jobs are now handed back immediately; see below.)*

## Sprint 4 — Retry policy, leases, heartbeat, and recovery

**Goal:** Recover from worker crashes and transient handler failures.

### Tasks
- [x] Add configurable maximum attempts and retryable/non-retryable error classification. *(Sprint 3: per-job `maxAttempts` with a queue default; `NonRetryableError`.)*
- [x] Implement exponential backoff with jitter.
- [x] Add job lease renewal using PostgreSQL time.
- [x] Reject state updates from workers with stale ownership/fencing tokens.
- [x] Implement worker heartbeat and worker status transitions.
- [x] Recover jobs whose execution leases have expired.
- [x] Preserve interrupted attempt history and transition jobs to retry or terminal state.
- [x] Handle stale Redis pending entries with `XPENDING` / `XAUTOCLAIM` where appropriate.
- [x] Add graceful worker shutdown and bounded draining.
- [x] Test crash windows: before claim, during execution, after DB completion but before `XACK`, and during recovery.

### Acceptance criteria
- [x] Expired jobs are recovered without stale workers overwriting newer state.
- [x] Attempt history is retained.
- [x] Retry exhaustion reaches a terminal state.
- [x] Shutdown stops new consumption and handles in-flight work safely.

### How it works (Sprint 4)
- **New process:** `npm run recovery` (PostgreSQL only; several instances are safe). Every `RECOVERY_INTERVAL_MS` it runs three steps, each claiming rows with `FOR UPDATE SKIP LOCKED` and re-checking the condition in the `UPDATE`:
  1. **Expired leases:** an `ACTIVE` job whose `lock_expires_at` has passed gets its `RUNNING` attempt marked `INTERRUPTED` (`LEASE_EXPIRED`), then goes to `RETRYING` with backoff, or to `DEAD` if that was its last attempt. This is one statement, so the job and its attempt change together. The interrupted attempt counts toward `max_attempts`, so a job that crashes its worker every time eventually stops.
  2. **Retry release:** due `RETRYING` jobs become `WAITING`, and a `job.ready` outbox event is inserted in the same transaction (event policy).
  3. **Worker health:** workers with no heartbeat for `WORKER_HEARTBEAT_TIMEOUT_MS` are marked `UNHEALTHY`. This is informational only; leases are what keep jobs safe. A worker that comes back resets its own status on its next heartbeat. `STOPPED` workers are never changed.
- **Lease renewal:** while a handler runs, the worker extends `lock_expires_at` every `WORKER_LEASE_RENEW_MS` (default: a third of the lease). The renewal is fenced on `locked_by` + `lease_version`. The handler's `signal` is aborted if renewal finds another owner, or if renewal keeps failing until the lease has certainly expired. The outcome is then discarded and the entry acknowledged, because the new owner is responsible. **Handlers that run long must honour `signal`.**
- **Fencing:** after recovery, the old worker's complete, fail and renew calls all match zero rows, because the job is no longer `ACTIVE` under its `locked_by`/`lease_version`. A worker may still finish after its lease expired if nobody has taken the job over yet.
- **Stale pending entries:** every `WORKER_PENDING_CHECK_MS`, a worker with free slots runs `XAUTOCLAIM` for entries idle longer than `WORKER_PENDING_IDLE_MS` in any consumer, then processes them normally. The PostgreSQL claim still decides whether anything runs. This covers:
  - a crash after reading but before claiming (the job is still `WAITING`, so it runs)
  - a crash after the outcome commit but before `XACK` (the job is terminal, so the entry is discarded)
  - entries left pending by database errors

  Taking over an entry whose job is still `ACTIVE` with a live worker is harmless: it is acknowledged as redundant.
- **Heartbeat:** every `WORKER_HEARTBEAT_MS` the worker updates `last_heartbeat_at`, `active_jobs` and its own status (`RUNNING` / `DRAINING`). Heartbeats continue while draining.
- **Shutdown:** handlers aborted at the end of the grace period have actually returned. Their job is therefore handed back at once: the attempt becomes `INTERRUPTED` (`WORKER_SHUTDOWN`) and the job goes to `RETRYING`/`DEAD` with a fenced write, and the entry is acknowledged. If that write fails, the job stays `ACTIVE` and lease recovery handles it.
- Crash windows covered by `test/recovery.test.js`: before claim, during execution, after the DB outcome but before `XACK`, recovery racing a finishing worker, concurrent recovery instances, renewal loss, and retry exhaustion. A real `taskkill /F` of a worker mid-job was also verified end to end.
- **Known limits** (all closed in Sprint 5): dead consumers are now removed, streams and outbox rows are trimmed by retention, and `SCHEDULED` jobs are released by the scheduler.

## Sprint 5 — Scheduling and queue controls

**Goal:** Add time-based execution and operational controls.

### Tasks
- [x] Implement delayed/scheduled job release.
- [x] Add queue pause/resume.
- [x] Add job cancellation; running cancellation must be cooperative.
- [x] Enforce worker and queue concurrency limits.
- [x] Add rate limiting if required by the MVP. *Decision: not required for the MVP. Queue concurrency covers the common need of protecting a downstream service. Per-queue rate limits (jobs per interval) can be added later at the same claim point.*
- [x] Define retention/cleanup for completed jobs and old attempts.

### Acceptance criteria
- [x] Scheduled jobs become eligible at the correct time (within one `RECOVERY_INTERVAL_MS`, never early).
- [x] Paused queues do not dispatch new work.
- [x] Concurrency limits hold across multiple worker processes.
- [x] Running cancellation does not falsely report a job as stopped while its handler is still executing.

### How it works (Sprint 5)
- **Scheduler:** the recovery process has a new step. Due `SCHEDULED` jobs (`delayMs` / `scheduledAt`) become `WAITING`, and a `job.ready` event is inserted in the same transaction. This is the same code path as retry release: `FOR UPDATE SKIP LOCKED`, with the status re-checked in the `UPDATE`, so several instances are safe. A job is never released early. It is released at most one `RECOVERY_INTERVAL_MS` late, plus the publisher poll and worker read.
- **Claim-time queue controls:** the claim now locks the queue row first (`FOR NO KEY UPDATE`). Under that lock it reads the queue status and counts the queue's `ACTIVE` jobs:
  - Queue not `ACTIVE` (paused or archived) → `{ rejected: 'QUEUE_NOT_ACTIVE' }`.
  - Queue already running `queues.concurrency` jobs → `{ rejected: 'QUEUE_AT_CAPACITY' }`.

  Claims on one queue are serialized, so the count includes every committed claim from every worker process. `NO KEY UPDATE` doesn't conflict with the `KEY SHARE` lock that job inserts take, so submission is never blocked. Cost: claims on a single queue run one at a time; each holds the lock for only a few milliseconds. An `ACTIVE` job whose worker died still holds its slot until lease recovery frees it.
- **Pause/resume:** `POST /queues/:id/pause` and `/resume`, or `PATCH status`. Status changes take the same queue-row lock, so a claim and a pause never interleave. Jobs submitted to a paused queue are accepted and stay `WAITING`.
  - Entries a worker reads for a paused queue are acknowledged without running anything.
  - When a queue becomes `ACTIVE` again, every `WAITING` job gets a fresh `job.ready` event in the same transaction as the status change. This extends the event policy: *every transition that makes a WAITING job claimable again emits an event*.
  - Workers using `WORKER_QUEUES=*` stop reading paused and archived streams within `WORKER_QUEUE_REFRESH_MS`. This is only an optimization; the claim check is what enforces the pause.
  - Scheduled and retry releases still happen while paused; those jobs wait as `WAITING`.
  - Resume emits one event per waiting job in a single transaction, which is fine at MVP scale.
- **Concurrency:** `WORKER_CONCURRENCY` limits each process, as before. `queues.concurrency` limits each queue across all workers, enforced by the claim.
  - When a claim is rejected for capacity, the worker **defers** the entry: no ack, so it stays pending and a crash loses nothing. The worker stops reading that queue's stream and retries the claim with backoff (`WORKER_CAPACITY_RETRY_BASE_MS` to `WORKER_CAPACITY_RETRY_MAX_MS`).
  - So a full queue costs each worker about one claim attempt per backoff interval, rather than a stream of rejections.
  - Deferred entries are left pending on shutdown; XAUTOCLAIM hands them to another worker.
- **Cancellation:** `POST /jobs/:id/cancel`.
  - `SCHEDULED`, `WAITING` or `RETRYING` jobs become `CANCELLED` immediately (`200`). Nothing is running them, and the claim only takes `WAITING` jobs. This is a single guarded `UPDATE`: if a claim commits first, the re-check sees `ACTIVE` and the running-job path below applies.
  - An `ACTIVE` job only gets `cancel_requested_at` and **stays `ACTIVE`** (`202`). Every `WORKER_CANCEL_CHECK_MS`, each worker queries for cancel requests on its running jobs and aborts those handlers' `signal`. Once the handler has returned, the job and its attempt are written as `CANCELLED`, fenced like any other outcome.
  - A handler that ignores the signal and succeeds is recorded as `COMPLETED`, because that is what happened. A failure after a cancel request becomes `CANCELLED` and is never retried.
  - If a worker dies while a cancel is pending, lease recovery turns the job `CANCELLED` (attempt `INTERRUPTED`) instead of retrying it. This relies on the lease being expired, the same assumption Sprint 4 makes.
  - Cancelling a `CANCELLED` job is a no-op `200`. Other finished jobs return `409 JOB_NOT_CANCELLABLE`.
- **Retention:** runs in the recovery process every `RETENTION_INTERVAL_MS`, in batches of `RETENTION_BATCH_SIZE` using `SKIP LOCKED`. An age of `0` keeps that data forever.
  - **Jobs:** `COMPLETED` jobs older than `JOB_RETENTION_COMPLETED_MS` (default 7 days) and `FAILED` / `DEAD` / `CANCELLED` jobs older than `JOB_RETENTION_FAILED_MS` (default 30 days) are deleted, measured from `completed_at`. Their attempts go with them through the FK cascade. Deleting a job frees its idempotency key.
  - **Outbox:** `PUBLISHED` events older than `OUTBOX_RETENTION_MS` (default 1 day) are deleted. `PENDING` and `PROCESSING` events never are.
  - **Streams:** each stream is trimmed with `XTRIM MINID` to the oldest entry still needed. Nothing at or after a group's smallest pending ID or its first undelivered entry is removed. Acknowledged entries are kept for `STREAM_RETENTION_MS` (default 1 hour). Streams without a consumer group are never trimmed. Redis is used only here; the step is skipped while Redis is down.
  - **Consumers:** removed with `XGROUP DELCONSUMER` only when all of these hold:
    - no pending entries;
    - idle longer than `STREAM_CONSUMER_RETENTION_MS`;
    - the worker row is `STOPPED`, gone, or silent for that long.

    Pending entries are re-checked right before the delete.
- **Known limits:**
  - A freed queue slot is noticed on the next capacity retry, so a saturated queue can sit idle for up to `WORKER_CAPACITY_RETRY_MAX_MS` between jobs. In the end-to-end smoke test, 6 one-second jobs at concurrency 2 took about 5.7s instead of the ideal 3s. Lower the max for latency, or later add a slot-freed notification.
  - Scheduled jobs start up to about `RECOVERY_INTERVAL_MS` + `OUTBOX_POLL_INTERVAL_MS` after their time; the smoke test measured about 1.7s late with 1s defaults.
- End to end (API, publisher, recovery and two workers, each a separate process) was verified: the limit held at 2 active jobs across both workers, a delayed job ran after its delay, a paused queue held a job for 3s and ran it on resume, a running 60s job was cancelled in under 1s (attempt `CANCELLED`), and cancelling a completed job returned `409`.
- Tests: `test/controls.test.js` covers scheduling accuracy and concurrent release, a pause racing a claim, resume re-announcement, every cancellation path (including a handler that ignores its signal), the concurrency limit under simultaneous claims and with two running worker loops, and retention boundaries for rows, stream entries and consumers.

## Sprint 6 — Dashboard and real-time visibility

**Goal:** Expose queue operations and job execution status. Divided into 3 incremental parts so each part stays small, testable, and easy to verify.

### Sprint 6A — Auth, App Shell, and Queues Management
- [x] Set up frontend routing, API client (JWT attach + 401 handling), and Login/Register pages.
- [x] Build main dashboard layout (sidebar/header, navigation between Queues and Workers, logout).
- [x] Build Queues page: list queues with search, status filter (`ACTIVE`, `PAUSED`, `ARCHIVED`), pagination, and empty/error states.
- [x] Add queue actions: create queue, edit queue, pause, and resume.

#### How it works (Sprint 6A)
- **Stack:** React 19 + Vite, React Router 7, and plain CSS with light/dark tokens (`src/index.css`). There is no state library: pages fetch from the API directly. Tests use Vitest, Testing Library and jsdom.
- **Run it:** start the API (`backend/api`: `npm run dev`), then in `frontend/` run `npm run dev` and open `http://localhost:5173`.
  - The Vite dev server proxies `/api` to `http://localhost:4000` (override with `VITE_API_PROXY_TARGET`), so the browser talks to a single origin.
  - For a separately hosted build, set `VITE_API_BASE_URL` (for example `https://api.example.com/api/v1`) and add that origin to the API's `CORS_ORIGIN`.
- **API client** (`src/api/client.js`):
  - Attaches `Authorization: Bearer <token>`.
  - Turns every failure into an `ApiError` with the API's `code`, `message` and `details`. Network failures get `NETWORK_ERROR`. `fieldErrors()` maps validation details to form fields.
  - A 401 on an authenticated request clears the token and ends the session. A 401 from login does not.
- **Session** (`src/auth/AuthContext.jsx`):
  - The token is kept in `localStorage`, falling back to memory if storage is blocked.
  - On load, `GET /auth/me` restores the user, so refreshing keeps the session while the token is valid.
  - Signed-out users are sent to `/login` and returned to the page they asked for, including its query string. An expired token shows "Your session has ended".
  - There is no refresh token: the user signs in again when `JWT_EXPIRES_IN` runs out.
- **Queues page:**
  - Search, status filter and page live in the URL (`/queues?status=PAUSED&search=mail&page=2`). Refreshing or sharing the link restores the same view from the API. Search is debounced by 300 ms.
  - Pause, resume and edit replace the row with the queue the API returned, so the UI only shows persisted state.
  - Create and edit validate on the client with the same rules as the server. Server errors such as `QUEUE_NAME_TAKEN` or validation details appear on the matching field.
  - Edit sends only the changed fields. Archiving is done through the edit dialog's status field.
- **Backend change:** `GET /queues` accepts `search` (case-insensitive substring match on the name, with `%` and `_` treated literally). It can be combined with `status`.
- **Workers page:** a placeholder until the workers endpoint arrives in 6B.
- **Tests:** `npm test` in `frontend/` runs 24 tests: the API client, form rules, auth flows (login redirect-back, register errors, session restore, logout, expiry mid-session), and the Queues page (filters in the URL, refresh restore, pagination, pause/resume, create/edit errors, empty/error states). On Windows, run them from PowerShell or cmd. From Git Bash, a lowercase drive letter in the working directory (`c:\`) makes Vitest load itself twice and fail with "failed to find the current suite".

### Sprint 6B — Jobs, Attempts, and Workers Visibility
- [x] Backend: add read-only `GET /api/v1/workers` endpoint to expose worker status, concurrency, active jobs, and last heartbeat.
- [x] Build Jobs page (per queue): list jobs with search, status filters, pagination, and empty/error states.
- [x] Add job actions: submit new job (payload JSON, delay/schedule, priority, max attempts, idempotency key) and cancel job (`WAITING`/`SCHEDULED`/`RETRYING` or cooperative `ACTIVE`).
- [x] Build Job Detail & Attempts view: inspect payload, result, error details, and full `job_attempts` timeline.
- [x] Build Workers page: inspect worker health (`RUNNING`, `DRAINING`, `UNHEALTHY`, `STOPPED`), active job count, and heartbeat timestamps.
- [x] Ensure refreshing any page restores the exact persisted state from API/PostgreSQL.

#### How it works (Sprint 6B)
- **`GET /api/v1/workers`** (authenticated, read-only): `?page&limit&status=RUNNING,UNHEALTHY`.
  - Live workers come first (anything not `STOPPED`), then the most recent heartbeat.
  - `heartbeatAgeMs` is computed with PostgreSQL `NOW()`, so the browser's clock doesn't affect it. `meta.statusCounts` gives counts per status over all workers.
  - **Visibility decision:** workers are shared infrastructure, so every signed-in user sees the list, including name, hostname, pid, status, capacity and heartbeat. What a worker consumes is filtered per caller: `consumesAllQueues` for `WORKER_QUEUES=*`, otherwise `queueIds` lists only the caller's own queues. Other tenants' queue IDs are never returned.
- **`GET /queues/:id/jobs?search=`** matches the job name case-insensitively (wildcards treated literally), or the exact job ID when the search is a UUID.
- **Routes:**
  - `/queues/:queueId/jobs`: search, status and page in the URL.
  - `/jobs/:jobId`: job detail.
  - `/workers`: status and page in the URL.

  Every page loads from the API on open and has a Refresh button, so a reload always shows persisted state. Live updates come in 6C.
- **Submit job:**
  - Name, with the built-in handlers suggested.
  - JSON-object payload, validated before sending.
  - When: now, after a delay in seconds (sent as `delayMs`), or at a local date and time (sent as an ISO `scheduledAt`).
  - Priority and max attempts, where blank means the queue default.
  - Idempotency key. Server errors such as `IDEMPOTENCY_KEY_CONFLICT` appear on the matching field.
- **Cancel:** available on the list and the detail page for `SCHEDULED`, `WAITING`, `RETRYING` and `ACTIVE` jobs, after a confirm prompt.
  - The row or page shows the job the API returned. `CANCELLED` means done.
  - An `ACTIVE` job shows "Cancelling…" with the time of the request until its handler returns, so a running job is never shown as stopped early.
- **Job detail:** summary, payload, result, last error, and the attempts timeline. Each attempt shows status, start and finish times, duration, worker, error code and message, and result. Error stacks are not exposed.
- **Workers page:** status tabs with counts, capacity bar (active / concurrency), heartbeat age, which queues the worker consumes, and start and stop times.
- Per CLAUDE.md, this increment added no tests. It was verified with `npm run build`, `npm run lint` and `node --check`.

### Sprint 6C — Real-time Updates (Socket.IO)
- [x] Backend: integrate Socket.IO on the API server (authenticated) and emit job/worker state change events **only after** state is persisted in PostgreSQL.
- [x] Frontend: connect `socket.io-client` to update queues, jobs, attempts, and worker health live without page refresh.
- [x] Keep Socket.IO strictly as an enhancement — reconnects/refreshes always fall back to API/PostgreSQL as the source of truth.

#### How it works (Sprint 6C)
- **Event source: PostgreSQL `NOTIFY` from triggers** (migration `20261128000008`). Triggers on `jobs`, `queues` and `workers` call `pg_notify('queueforge_events', …)`.
  - PostgreSQL delivers a notification only when the sending transaction commits, and drops it on rollback. So events can only describe committed state, whichever process wrote it: API, worker, recovery or publisher. No writer code changed.
  - What triggers an event:
    - jobs: insert, or a change of `status` or `cancel_requested_at`;
    - queues: any insert or update;
    - workers: insert, or a change of `status` or `active_jobs`.

    Lease renewals and heartbeats don't notify.
  - Payloads are small invalidation hints: `{ type, id, queueId?, status, activeJobs? }`, plus the owner's `userId` for routing only. Retention deletes don't notify.
- **API process** (`src/realtime/`):
  - `PgEventListener` holds one dedicated `LISTEN` connection, separate from the Sequelize pool, and reconnects with backoff.
  - After a reconnect it broadcasts `resync`, because notifications sent while it was disconnected are lost.
  - `createSocketServer` attaches Socket.IO to the HTTP server at `/socket.io`, with the same CORS origin as the API.
- **Socket auth and routing:**
  - The handshake requires `auth.token`, a valid access token checked like REST requests. The socket is disconnected when that token expires.
  - Job and queue events go only to the owner's room (`user:<id>`), and the `userId` is stripped before sending. Worker events go to every authenticated client.
  - Events are coalesced per room for 250 ms, latest state per entity, and sent as one `events` batch, so bursts (for example recovery releasing many jobs) stay cheap.
- **Clients never trust event contents as data.** They reload from the REST API, so ownership checks and serialization stay in one place, and the page always shows what PostgreSQL holds. Socket.IO can be down entirely and every page still works through load and Refresh.
- **Frontend** (`src/realtime/`):
  - `RealtimeProvider` connects while signed in. In development, the Vite dev server proxies `/socket.io` (with WebSocket upgrade). With an absolute `VITE_API_BASE_URL`, it connects to that origin.
  - `useLiveRefresh(match, refresh)` debounces matching events by 300 ms into one quiet reload (no dimming). Every subscriber reloads after a reconnect or a server `resync`.
  - What each page listens for:
    - Queues: any queue event.
    - Jobs: job events for this queue, and changes to the queue itself.
    - Job detail: events for this job (status, attempts, cancel progress).
    - Workers: worker events. Heartbeat ages advance locally between reloads.
  - The top bar shows the connection state: Live, Connecting, Reconnecting, or Live updates off.
- **Setup:** run `npm run db:migrate` in `backend/api`. The API refuses to start while migrations are pending.
- Per CLAUDE.md, this increment added no tests. It was verified with `npm run build`, `npm run lint` and `node --check`.

### Acceptance criteria
- [x] Users can inspect queues, jobs, attempts, and worker health.
- [x] Refreshing the dashboard restores the same persisted state.
- [x] Socket.IO is an enhancement, not the source of truth.

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

1. [ ] Sprint 7: structured logs with correlation IDs across API, publisher, worker and recovery.
2. [ ] Metrics: queue depth, waiting age, execution duration, retries, failures, worker utilization, publisher lag.
3. [ ] Health/readiness endpoints for every process, and Docker Compose services for all of them.
4. [ ] Tests for Sprint 6B/6C (workers endpoint, jobs search, notify triggers, socket auth and routing), which were deferred under the CLAUDE.md no-tests rule.
5. [ ] Optional: per-queue job counts by status on the Queues page.

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
