# CLAUDE.md

## Project Overview
QueueForge is a distributed job queue & dashboard system:
- `backend/api/` — Express API, Outbox Publisher (`npm run publisher`), Worker (`npm run worker`), and Recovery (`npm run recovery`)
- `frontend/` — Vite + React dashboard
- `docs/queueforge-sprint-wise-integration.md` — Sprint plan, acceptance criteria, and architecture notes

## Workflow & Token-Saving Rules
- **Focus on feature code first.** Do not write or update test files unless the user explicitly asks for tests.
- **Do NOT run `npm test` automatically.** The backend integration suite runs sequentially against PostgreSQL/Redis and is slow. Only run tests when explicitly requested, and even then run only the single relevant test file (`node --import ./test/setup.js --test test/<file>.test.js`).
- **Fast verification only (once at the end after all edits):**
  - Frontend (`frontend/`): run `npm run build` (and `npm run lint` if needed).
  - Backend (`backend/api/`): run `node --check <file>` on modified files if a quick syntax check is needed.
- **Work in small, incremental steps** matching the sprint sub-tasks (e.g., Sprint 6A, 6B, 6C separately).

## Architecture Invariants
- PostgreSQL is the source of truth for all persisted queue/job/attempt/worker state.
- Redis Streams is only for work delivery; never acknowledge (`XACK`) before durable DB state commits.
- Keep `backend/api` and `frontend` cleanly separated; frontend communicates via `/api/v1/*` and Socket.IO (as an enhancement, never as the source of truth).
