import { Op } from 'sequelize';
import { Job, JobAttempt, Queue } from '../models/index.js';

/**
 * Job reads are scoped to the owning user, either directly (join through
 * queues.user_id) or through a queue the caller has already been verified to own.
 */
export const jobRepository = {
  create: (fields) => Job.create(fields),

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

  listAttempts: (jobId) =>
    JobAttempt.findAll({ where: { jobId }, order: [['attemptNumber', 'ASC']] }),
};
