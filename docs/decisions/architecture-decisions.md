# Architecture Decisions

## ADR-001: Hybrid application architecture

**Decision:** Keep a modular control-plane API and run publisher, scheduler, recovery, and worker roles as independently scalable processes from one codebase.

**Reason:** Preserves clear runtime boundaries and independent scaling without premature microservice complexity.

## ADR-002: PostgreSQL as source of truth

**Decision:** Persist jobs, attempts, queue configuration, outbox events, and leases in PostgreSQL.

**Reason:** Strong transactions and queryability are important for job state, tenant isolation, and auditability.

## ADR-003: Redis Streams for transport

**Decision:** Use Redis Streams and consumer groups for distributing ready-job events.

**Reason:** Provides consumer groups, pending-entry tracking, acknowledgement, and reclaim operations. Redis is transport, not authoritative job state.

## ADR-004: Transactional outbox

**Decision:** Insert the job and its outbox event in one database transaction; publish asynchronously.

**Reason:** Avoids losing a job between a PostgreSQL commit and a Redis publish. Duplicate publication remains possible and is handled idempotently.

## ADR-005: At-least-once execution

**Decision:** Promise at-least-once delivery, not exactly-once execution.

**Reason:** A worker can perform an external side effect and crash before persisting completion. Idempotent handlers and downstream idempotency keys mitigate duplicate effects.

## ADR-006: PostgreSQL lease and fencing token

**Decision:** Use `locked_by`, `lock_expires_at`, and monotonically increasing `lease_version` for execution ownership.

**Reason:** Redis pending-entry ownership alone cannot prevent a stale worker from writing after recovery.

## ADR-007: Multi-tenant isolation

**Decision:** Scope tenant-owned operations by `organization_id` in repository methods and database constraints.

**Reason:** Prevents cross-tenant data access. RLS may be added as defense in depth.

## Deferred decisions

- Exact queue-wide concurrency implementation (PostgreSQL slots versus Redis semaphore).
- Final lease/heartbeat timing after load and failure testing.
- Partitioning/retention strategy for high-volume jobs and attempts.
- RLS rollout.
- Production deployment topology and autoscaling policy.
