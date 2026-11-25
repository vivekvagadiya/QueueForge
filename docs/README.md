# TaskFlow Documentation

TaskFlow is a multi-tenant distributed job processing platform.

## Architecture decisions
- Backend: Node.js + Express, modular control-plane API, independently scalable execution processes.
- Persistence: PostgreSQL is the source of truth.
- Transport: Redis Streams with consumer groups.
- Delivery: at-least-once; handlers must be idempotent.
- Frontend: React + Vite + Tailwind.
- Real-time updates: Socket.IO.
- Local infrastructure: Docker Compose.
- Validation: Zod; authentication: JWT + RBAC.

## Documents
- `architecture/system-overview.md` — components and end-to-end flow.
- `architecture/database-design.md` — entities, constraints, and indexes.
- `architecture/job-lifecycle.md` — job states and transitions.
- `distributed-systems/job-claiming.md` — atomic ownership and fencing.
- `distributed-systems/lease-heartbeat.md` — lease renewal and worker health.
- `distributed-systems/concurrency-control.md` — worker and queue concurrency.
- `distributed-systems/failure-recovery.md` — crash handling, retries, and acknowledgements.
- `decisions/architecture-decisions.md` — key choices and trade-offs.

These documents describe the intended design. Treat implementation details and numeric thresholds as initial defaults to validate through load and failure testing.
