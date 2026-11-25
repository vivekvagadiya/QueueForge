# Database Design

PostgreSQL is the source of truth. Use UUID primary keys, UTC timestamps (`timestamptz`), explicit foreign keys, and migrations.

## Core entities

### `organizations`
- `id`, `name`, `slug` (unique), `plan`, `status`, `created_at`, `updated_at`.

### `users`
- `id`, `name`, `email` (unique), `password_hash`, `status`, `email_verified_at`, timestamps.
- Store only a password hash; use Argon2id or a securely configured bcrypt implementation.

### `organization_members`
- `id`, `organization_id`, `user_id`, `role`, `status`, `joined_at`, `created_at`.
- Unique `(organization_id, user_id)`.

### `api_keys`
- `id`, `organization_id`, `name`, `key_prefix`, `key_hash`, `scopes` (JSONB), `last_used_at`, `expires_at`, `revoked_at`, `created_at`.
- Generate a high-entropy secret, show it once, and persist only a verifier/hash plus a non-secret prefix.

### `queues`
- `id`, `organization_id`, `name`, `description`, `status`, `concurrency`, `rate_limit` (JSONB), `default_job_options` (JSONB), timestamps.
- Unique `(organization_id, name)`. `concurrency > 0`.
- Queue status: `ACTIVE`, `PAUSED`, `ARCHIVED`.

### `jobs`
- `id`, `organization_id`, `queue_id`, `name`, `payload` (JSONB), `status`, `priority`, `attempts_made`, `max_attempts`, `scheduled_at`, `started_at`, `completed_at`, `locked_by`, `lock_expires_at`, `lease_version`, `idempotency_key`, `result` (JSONB), `last_error` (JSONB), timestamps.
- `locked_by` identifies the worker instance holding the lease.
- `lease_version` is a monotonically increasing fencing token for each successful claim.
- Scope idempotency to the intended tenant/queue boundary, e.g. a unique constraint on `(organization_id, queue_id, idempotency_key)` where the key is not null.

### `job_attempts`
- `id`, `job_id`, `attempt_number`, `worker_id`, `status`, `started_at`, `finished_at`, `duration_ms`, `error_code`, `error_message`, `error_stack`, `result` (JSONB), `created_at`.
- Unique `(job_id, attempt_number)`. Keep attempt history; do not overwrite it with only a `last_error` field.

### `outbox_events`
- `id`, `aggregate_type`, `aggregate_id`, `event_type`, `payload` (JSONB), `status`, `attempts`, `published_at`, `next_attempt_at`, `locked_by`, `locked_at`, timestamps.
- Suggested states: `PENDING`, `PROCESSING`, `PUBLISHED`.
- Publisher claims rows transactionally (for example with `FOR UPDATE SKIP LOCKED`). Expired publisher claims must be recoverable.

### `worker_instances`
- `id`, `name`, `hostname`, `process_id`, `status`, `concurrency`, `active_jobs`, `queues` (JSONB), `last_heartbeat_at`, `started_at`, `stopped_at`, timestamps.
- Suggested states: `STARTING`, `RUNNING`, `DRAINING`, `STOPPED`, `UNHEALTHY`.
- A worker may serve multiple organizations, so do not assume every worker belongs to one tenant.

### `recurring_jobs`
- `id`, `organization_id`, `queue_id`, `name`, `job_name`, `payload` (JSONB), `cron_expression`, `timezone`, `status`, `next_run_at`, `last_run_at`, `options` (JSONB), timestamps.
- Keep recurring definitions separate from generated job instances.

### `audit_logs`
- `id`, `organization_id`, `actor_user_id`, `action`, `resource_type`, `resource_id`, `metadata` (JSONB), `ip_address` (INET), `user_agent`, `created_at`.

## Important constraints and indexes

Create indexes from actual query patterns; validate with `EXPLAIN (ANALYZE, BUFFERS)`.

Initial candidates:
- `queues`: unique `(organization_id, name)`.
- `jobs`: `(organization_id, queue_id, status, created_at DESC)` for tenant-scoped job lists.
- Scheduled jobs: partial index on `scheduled_at` where status is `SCHEDULED`.
- Retry due jobs: partial index on `scheduled_at` where status is `RETRYING`.
- Expired leases: partial index on `lock_expires_at` where status is `ACTIVE`.
- Outbox polling: `(next_attempt_at, created_at)` where status is `PENDING`.
- Attempts: `(job_id, attempt_number DESC)`.

Use composite foreign keys where useful to ensure a job's `organization_id` and `queue_id` refer to the same tenant-owned queue. Confirm exact Sequelize migration syntax and constraint names during implementation.

## Tenant isolation

Every tenant-owned query must include the organization scope. Repository methods should require tenant context, e.g. `findJob({ jobId, organizationId })`. Avoid generic methods that can accidentally query by ID alone. PostgreSQL Row-Level Security can be added later as defense in depth.
