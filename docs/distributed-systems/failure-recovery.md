# Failure Recovery, Retries, and Acknowledgement

## Core rule

Persist authoritative state changes in PostgreSQL before acknowledging the corresponding Redis stream entry.

## Acknowledgement sequence

1. Receive stream entry with `XREADGROUP`.
2. Load job and attempt an atomic PostgreSQL claim.
3. Execute only after claim succeeds.
4. Persist attempt result and job transition using worker ID + lease version.
5. Commit the database transaction.
6. `XACK` the Redis entry.

If the worker crashes after step 5 but before step 6, Redis may redeliver the entry. The next consumer checks PostgreSQL, sees the terminal or no-longer-eligible state, and safely avoids re-execution.

Never acknowledge before the durable state transition; otherwise the message may be lost while the database still says the job is active or waiting.

## Failure scenarios

| Failure | Expected behavior |
|---|---|
| API crashes before DB commit | No accepted job exists |
| API crashes after DB commit | Job and outbox event remain durable |
| Publisher crashes before `XADD` | Outbox event is retried |
| Publisher crashes after `XADD` but before marking published | Duplicate stream event is possible; consumer is idempotent |
| Redis unavailable | Outbox remains pending; publisher retries |
| Worker crashes during execution | Lease expires; recovery makes job eligible for retry |
| Worker crashes after DB completion before `XACK` | Redelivery is recognized as duplicate |
| Old worker resumes after reassignment | Fencing token rejects stale DB updates |

## Recovery process

Periodically find `ACTIVE` jobs whose `lock_expires_at` has passed. In a transaction:
- Verify the lease is still expired.
- Mark the prior attempt interrupted/failed with a recovery reason.
- Clear the old owner and lease.
- Move the job to `RETRYING` or `DEAD`, based on retry policy.
- Persist the next eligible time when retrying.

Use guarded updates and row locking to avoid racing a valid heartbeat. A lease expiry does not prove the old worker stopped; fencing tokens are required to prevent stale writes.

## Redis pending entries

Use `XPENDING` for inspection and `XAUTOCLAIM`/`XCLAIM` to transfer stale pending stream entries to another consumer. This only changes Redis consumer ownership. It does not replace PostgreSQL lease recovery or grant execution rights.

## Transactional outbox

The API inserts the job and outbox event in one PostgreSQL transaction. Publisher claims pending rows, publishes to Redis, and marks them published. Since a crash can occur between publish and marking, duplicate publication is expected and must be safe.

## Graceful shutdown

On shutdown:
1. Mark worker `DRAINING`.
2. Stop reading new stream entries.
3. Finish in-flight jobs within the shutdown grace period.
4. Persist outcomes and acknowledge completed entries.
5. If a job cannot finish, do not falsely mark it complete; let its lease expire and be recovered.
