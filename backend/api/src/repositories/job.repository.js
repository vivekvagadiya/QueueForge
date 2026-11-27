import { Op, QueryTypes } from 'sequelize';
import { getDatabase } from '../config/database.js';
import { Job, JobAttempt, Queue } from '../models/index.js';

/**
 * Job reads are scoped to the owning user, either directly (join through
 * queues.user_id) or through a queue the caller has already been verified to own.
 */
export const jobRepository = {
  /**
   * Inserts a job, or does nothing if another job in the same queue already
   * holds the idempotency key. Returns the new Job, or null on a key conflict.
   *
   * ON CONFLICT DO NOTHING (rather than catching a unique violation) keeps the
   * surrounding transaction usable, so the outbox insert can follow in the same
   * transaction. Under READ COMMITTED it waits for a concurrent insert of the
   * same key to commit, so a follow-up lookup sees the winner.
   */
  async insertUnlessDuplicateKey(fields, { transaction }) {
    const rows = await getDatabase().query(
      `INSERT INTO jobs (queue_id, name, payload, status, scheduled_at, priority, max_attempts, idempotency_key)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
       ON CONFLICT (queue_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      {
        bind: [
          fields.queueId,
          fields.name,
          JSON.stringify(fields.payload),
          fields.status,
          fields.scheduledAt,
          fields.priority,
          fields.maxAttempts,
          fields.idempotencyKey,
        ],
        type: QueryTypes.SELECT,
        transaction,
      }
    );
    return rows.length === 0 ? null : Job.findByPk(rows[0].id, { transaction });
  },

  /** `queueId` must come from a queue already verified as owned by the caller. */
  findByIdempotencyKey: ({ queueId, idempotencyKey }) =>
    Job.findOne({ where: { queueId, idempotencyKey } }),

  findForUser: ({ jobId, userId }) =>
    Job.findOne({
      where: { id: jobId },
      include: [{ model: Queue, as: 'queue', where: { userId }, attributes: [], required: true }],
    }),

  /** `queueId` must come from a queue already verified as owned by the caller. */
  listForQueue: ({ queueId, statuses, limit, offset }) =>
    Job.findAndCountAll({
      where: { queueId, ...(statuses ? { status: { [Op.in]: statuses } } : {}) },
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
      offset,
    }),

  /**
   * Cancels a job in one guarded statement. SCHEDULED, WAITING and RETRYING
   * jobs become CANCELLED at once (nothing is running them, and the claim only
   * takes WAITING jobs). An ACTIVE job only gets cancel_requested_at: its
   * worker aborts the handler and records CANCELLED once it has stopped.
   * If a claim commits first, the WHERE re-check sees the ACTIVE row and the
   * request path applies. Returns the new status, or null if the job was
   * already finished. `jobId` must already be verified as owned by the caller.
   */
  async requestCancel(jobId) {
    const rows = await getDatabase().query(
      `UPDATE jobs
       SET status = CASE WHEN status = 'ACTIVE' THEN status ELSE 'CANCELLED' END,
           cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
           completed_at = CASE WHEN status = 'ACTIVE' THEN completed_at ELSE NOW() END,
           updated_at = NOW()
       WHERE id = $1 AND status IN ('SCHEDULED', 'WAITING', 'RETRYING', 'ACTIVE')
       RETURNING status`,
      { bind: [jobId], type: QueryTypes.SELECT }
    );
    return rows[0]?.status ?? null;
  },

  findById: (jobId) => Job.findByPk(jobId),

  listAttempts: (jobId) =>
    JobAttempt.findAll({ where: { jobId }, order: [['attemptNumber', 'ASC']] }),
};
