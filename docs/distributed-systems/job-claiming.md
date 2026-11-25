# Job Claiming and Execution Ownership

## Two different ownership systems

- Redis consumer-group ownership controls which consumer currently has a stream entry.
- PostgreSQL lease ownership controls which worker is allowed to execute and mutate a job.

PostgreSQL is authoritative. A Redis delivery alone does not grant execution rights.

## Atomic claim

A worker must claim the job before running its handler. Use a short database transaction that:
1. Conditionally updates the job only if it is still eligible (`WAITING`).
2. Sets `status = ACTIVE`, `locked_by = workerId`, and `lock_expires_at`.
3. Increments `lease_version`.
4. Increments `attempts_made`.
5. Inserts the corresponding `job_attempts` row.
6. Commits before handler execution begins.

The guarded update is the concurrency boundary: only one worker can change a given eligible job from `WAITING` to `ACTIVE`.

Illustrative SQL shape (adapt names and transaction handling to the final schema):

```sql
UPDATE jobs
SET status = 'ACTIVE',
    locked_by = :worker_id,
    lock_expires_at = NOW() + INTERVAL '30 seconds',
    lease_version = lease_version + 1,
    attempts_made = attempts_made + 1,
    started_at = NOW(),
    updated_at = NOW()
WHERE id = :job_id
  AND organization_id = :organization_id
  AND status = 'WAITING'
RETURNING id, lease_version, attempts_made, payload;
```

Insert the attempt row in the same transaction. If the update returns no row, the worker must not execute the job.

## Fencing token

`lease_version` increases on every successful claim. Every heartbeat and final state update must include:
- job ID,
- worker ID (`locked_by`),
- the exact `lease_version`,
- expected state.

This prevents an old worker from updating the job after recovery has reassigned it. A stale worker may still be running code, but its database writes are rejected.

## Duplicate delivery handling

If claim fails, inspect the current persisted state:
- Terminal job: acknowledge the duplicate stream entry.
- Already active under a valid lease: do not execute a second copy; acknowledge only when the event is known to be redundant under the chosen event policy.
- Still eligible but claim failed due to a transient DB error: do not acknowledge; allow retry/recovery.
- Missing or tenant-mismatched job: log and handle as an invalid/stale event according to retention policy.

Do not treat every failed claim as permission to acknowledge without checking why it failed.
