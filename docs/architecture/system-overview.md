# System Overview

## Purpose
TaskFlow accepts background jobs, persists them, distributes them to workers, and exposes operational controls and visibility.

Example workloads: email delivery, PDF generation, image processing, webhook delivery, and data synchronization.

## High-level components

| Component | Responsibility |
|---|---|
| React dashboard | Queue, job, worker, and organization management |
| API server | Auth, tenant authorization, queue/job APIs, validation |
| PostgreSQL | Authoritative job state, configuration, attempts, and outbox |
| Outbox publisher | Publishes committed events to Redis Streams |
| Redis Streams | Durable-ish transport and consumer-group coordination |
| Worker processes | Execute registered job handlers |
| Scheduler | Releases delayed jobs and creates recurring runs |
| Recovery process | Finds expired leases and repairs interrupted work |
| Socket.IO | Pushes dashboard updates |
| Prometheus/Grafana | Later-stage metrics and monitoring |

API and worker processes are separate runtime processes in one codebase initially. They can scale independently without starting with a large microservice fleet.

## Job submission and execution

1. Client submits `POST /api/v1/queues/:queueName/jobs`.
2. API authenticates the caller and checks organization membership, queue access, payload, options, and idempotency.
3. A PostgreSQL transaction inserts the `jobs` row and corresponding `outbox_events` row.
4. API returns the persisted job ID.
5. Publisher claims pending outbox rows and writes lightweight events to Redis using `XADD`.
6. Worker receives entries through `XREADGROUP`.
7. Worker claims the job in PostgreSQL using an atomic conditional update.
8. Worker executes the handler outside the database transaction.
9. Worker records the attempt outcome and updates the job using its current lease/fencing token.
10. Worker acknowledges the stream entry using `XACK` only after the durable state update succeeds.

## Data ownership

- PostgreSQL owns job truth: status, attempts, schedule, result, errors, and execution lease.
- Redis Streams transports notifications that work may be ready.
- Redis pending-entry state is not the authoritative job state.
- Workers own execution only while holding a valid PostgreSQL lease.

## Delivery semantics

TaskFlow provides at-least-once delivery, not exactly-once execution. A crash after an external side effect but before completion is persisted can cause the handler to run again. Handlers should therefore be idempotent, and external providers' idempotency mechanisms should be used where available.

## Initial deployment shape

Run API, publisher, scheduler, recovery process, and workers as separate processes/containers from the same repository. Keep module boundaries clear; split services only when operational or scaling evidence justifies it.
