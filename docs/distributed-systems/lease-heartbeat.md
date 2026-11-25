# Lease and Heartbeat

## Lease model

A lease is a time-bounded execution ownership record in PostgreSQL:
- `locked_by`: worker instance ID.
- `lock_expires_at`: lease expiry timestamp.
- `lease_version`: monotonically increasing fencing token.

The lease is authoritative for whether a worker may update job state.

## Initial timing defaults

- Lease duration: 30 seconds.
- Heartbeat interval: 10 seconds.
- Worker heartbeat: every 5 seconds.

These are starting values, not universal constants. Tune them based on job behavior, database latency, runtime pauses, and recovery objectives. Heartbeats should occur substantially more frequently than lease expiry.

## Heartbeat operation

Renew only if the worker still owns the current lease:

```sql
UPDATE jobs
SET lock_expires_at = NOW() + INTERVAL '30 seconds',
    updated_at = NOW()
WHERE id = :job_id
  AND status = 'ACTIVE'
  AND locked_by = :worker_id
  AND lease_version = :lease_version
  AND lock_expires_at > NOW();
```

If zero rows are updated, ownership has been lost or expired. The worker must stop making authoritative state changes and should attempt to stop the handler cooperatively.

## Worker heartbeat

Worker process heartbeat updates `worker_instances.last_heartbeat_at`. It indicates process liveness, not proof that every active job is healthy. Track job leases separately.

A possible initial policy is a heartbeat every 5 seconds and mark a worker suspect after 15 seconds without a heartbeat, followed by a configurable grace period before operational recovery. Do not use worker heartbeat alone to reassign jobs; inspect each job's lease.

## Clock and timing

Use PostgreSQL time (`NOW()`) for lease comparisons and renewal to avoid relying on potentially skewed worker clocks. Handle transient heartbeat failures conservatively: a worker should not assume its lease remains valid after it can no longer confirm renewal.
