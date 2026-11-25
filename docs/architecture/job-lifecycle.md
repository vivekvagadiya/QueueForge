# Job Lifecycle

## States

| State | Meaning |
|---|---|
| `SCHEDULED` | Persisted but not eligible until its scheduled time |
| `WAITING` | Ready to be claimed |
| `ACTIVE` | Claimed by a worker with a valid lease |
| `RETRYING` | Previous attempt failed; waiting for retry time |
| `COMPLETED` | Successfully completed |
| `FAILED` | Terminal failure that is not retryable |
| `DEAD` | Retry limit exhausted |
| `CANCELLED` | Cancelled before completion |

## Main transitions

- `SCHEDULED -> WAITING`: scheduler releases the job when due.
- `WAITING -> ACTIVE`: worker successfully claims it.
- `ACTIVE -> COMPLETED`: handler succeeds and completion is persisted.
- `ACTIVE -> RETRYING`: retryable attempt failure; set next eligible time.
- `RETRYING -> WAITING`: retry scheduler releases it when due.
- `ACTIVE -> FAILED`: non-retryable error or policy says stop.
- `ACTIVE -> DEAD`: retry budget is exhausted.
- `WAITING/SCHEDULED/RETRYING -> CANCELLED`: cancellation before execution.

Active cancellation is cooperative. Signal the owning worker and let the handler observe cancellation; do not simply change the row to `CANCELLED` while code may still be executing.

## Attempts versus jobs

A job is the logical unit of work. An attempt is one execution try. An attempt may fail while the job transitions to `RETRYING`; that does not mean the job is terminally `FAILED`.

`attempts_made` counts started attempts. `job_attempts` preserves per-attempt timing, worker, result, and error details.

## Retry policy

Use configurable maximum attempts and backoff. An initial policy can use exponential backoff with jitter:

`delay = min(maxDelay, baseDelay * 2^(attemptNumber - 1)) + jitter`

Persist the calculated next eligible time. Avoid tight retry loops for persistent downstream failures.
