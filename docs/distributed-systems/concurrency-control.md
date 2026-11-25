# Concurrency Control

## Three levels

1. **Worker-local concurrency**: maximum handlers running inside one worker process.
2. **Queue-wide concurrency**: aggregate maximum active jobs across all workers for a queue.
3. **Rate limit**: maximum starts over a time window, independent of simultaneous active jobs.

These are separate controls and should not be conflated.

## Initial implementation

Start with configurable worker-local concurrency and enforce queue-wide limits through a shared coordination mechanism before claiming more work. For an advanced implementation, use PostgreSQL-backed queue slots or a Redis atomic semaphore with explicit expiry and recovery semantics.

Do not implement a queue-wide limit by reading an active-job count and then incrementing it in separate operations; concurrent workers can exceed the limit. Acquisition must be atomic.

## Claim ordering

A worker should:
1. Check that the queue is active and has capacity.
2. Acquire a queue execution slot atomically.
3. Claim the job in PostgreSQL.
4. Release the slot if the job claim fails.
5. Hold the slot while executing.
6. Release it on completion, failure, cancellation, or lease recovery.

The queue slot must itself be recoverable if a worker crashes. Tie it to an owner and expiry/fencing token, or derive capacity from authoritative active job leases.

## Backpressure

Stop reading/claiming more work when local capacity is full. Avoid buffering unbounded numbers of jobs in worker memory. Scale worker replicas based on queue backlog, oldest waiting age, processing latency, and resource saturation—not backlog count alone.
