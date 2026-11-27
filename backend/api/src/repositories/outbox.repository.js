import { QueryTypes } from 'sequelize';
import { getDatabase } from '../config/database.js';
import { OutboxEvent, OUTBOX_EVENT_TYPES } from '../models/outboxEvent.model.js';

const toEvent = (row) => ({
  id: row.id,
  aggregateType: row.aggregate_type,
  aggregateId: row.aggregate_id,
  eventType: row.event_type,
  payload: row.payload,
  attempts: row.attempts,
});

/**
 * All timing comparisons use PostgreSQL NOW(), not the publisher's clock.
 * Every state change after a claim is guarded by `locked_by`, so a publisher
 * whose claim expired and was taken over cannot overwrite the new owner's state.
 */
export const outboxRepository = {
  /** Must be called inside the transaction that changes the job. */
  createJobReady: (job, { transaction }) =>
    OutboxEvent.create(
      {
        aggregateType: 'job',
        aggregateId: job.id,
        eventType: OUTBOX_EVENT_TYPES.JOB_READY,
        payload: { jobId: job.id, queueId: job.queueId },
      },
      { transaction }
    ),

  /**
   * Inserts a job.ready event for every WAITING job in the queue. Used when a
   * queue becomes ACTIVE again: entries consumed while it was paused were
   * acknowledged without running, so every waiting job is announced afresh.
   * Duplicates are harmless (the claim decides). Returns the number of events.
   * Must be called inside the transaction that changes the queue status.
   */
  async createJobReadyForWaiting(queueId, { transaction }) {
    const rows = await getDatabase().query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       SELECT 'job', id, $2, jsonb_build_object('jobId', id, 'queueId', queue_id)
       FROM jobs
       WHERE queue_id = $1 AND status = 'WAITING'
       ORDER BY priority DESC, created_at
       RETURNING id`,
      { bind: [queueId, OUTBOX_EVENT_TYPES.JOB_READY], type: QueryTypes.SELECT, transaction }
    );
    return rows.length;
  },

  /**
   * Atomically claims up to `limit` events: due PENDING events, plus PROCESSING
   * events whose claim is older than `claimTimeoutMs` (publisher crashed).
   * SKIP LOCKED lets concurrent publishers claim disjoint batches without waiting.
   */
  async claimBatch({ publisherId, limit, claimTimeoutMs }) {
    return (
      await getDatabase().query(
        `WITH claimable AS (
           SELECT id FROM outbox_events
           WHERE (status = 'PENDING' AND next_attempt_at <= NOW())
              OR (status = 'PROCESSING' AND locked_at < NOW() - make_interval(secs => $3::double precision / 1000))
           ORDER BY created_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE outbox_events o
         SET status = 'PROCESSING',
             locked_by = $1,
             locked_at = NOW(),
             attempts = o.attempts + 1,
             updated_at = NOW()
         FROM claimable
         WHERE o.id = claimable.id
         RETURNING o.*`,
        { bind: [publisherId, limit, claimTimeoutMs], type: QueryTypes.SELECT }
      )
    )
      .sort((a, b) => a.created_at - b.created_at)
      .map(toEvent);
  },

  /**
   * Marks events published. Returns the IDs actually updated; an ID missing
   * from the result means this publisher lost its claim (the event will be or
   * was published again by the new owner — a tolerated duplicate).
   */
  async markPublished({ publisherId, published }) {
    if (published.length === 0) {
      return [];
    }
    const rows = await getDatabase().query(
      `UPDATE outbox_events o
       SET status = 'PUBLISHED',
           published_at = NOW(),
           stream_id = p.stream_id,
           locked_by = NULL,
           locked_at = NULL,
           last_error = NULL,
           updated_at = NOW()
       FROM jsonb_to_recordset($2::jsonb) AS p(id uuid, stream_id text)
       WHERE o.id = p.id AND o.status = 'PROCESSING' AND o.locked_by = $1
       RETURNING o.id`,
      {
        bind: [publisherId, JSON.stringify(published.map((p) => ({ id: p.id, stream_id: p.streamId })))],
        type: QueryTypes.SELECT,
      }
    );
    return rows.map((r) => r.id);
  },

  /** Releases a failed event back to PENDING with a retry delay. Returns false if the claim was lost. */
  async markFailed({ publisherId, id, error, retryDelayMs }) {
    const rows = await getDatabase().query(
      `UPDATE outbox_events
       SET status = 'PENDING',
           next_attempt_at = NOW() + make_interval(secs => $3::double precision / 1000),
           last_error = $4,
           locked_by = NULL,
           locked_at = NULL,
           updated_at = NOW()
       WHERE id = $2 AND status = 'PROCESSING' AND locked_by = $1
       RETURNING id`,
      { bind: [publisherId, id, retryDelayMs, String(error).slice(0, 2000)], type: QueryTypes.SELECT }
    );
    return rows.length === 1;
  },

  /** Backlog metrics for logs/health: pending count and age of the oldest due event. */
  async stats() {
    const [row] = await getDatabase().query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
         COUNT(*) FILTER (WHERE status = 'PROCESSING')::int AS processing,
         COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(created_at) FILTER (WHERE status <> 'PUBLISHED')) * 1000, 0)::bigint AS oldest_unpublished_age_ms
       FROM outbox_events
       WHERE status <> 'PUBLISHED'`,
      { type: QueryTypes.SELECT }
    );
    return {
      pending: row.pending,
      processing: row.processing,
      oldestUnpublishedAgeMs: Number(row.oldest_unpublished_age_ms),
    };
  },
};
