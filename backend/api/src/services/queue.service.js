import { UniqueConstraintError } from 'sequelize';
import { getDatabase } from '../config/database.js';
import { outboxRepository } from '../repositories/outbox.repository.js';
import { queueRepository } from '../repositories/queue.repository.js';
import { conflict, notFound } from '../utils/AppError.js';
import { paginationMeta, serializeQueue } from './serializers.js';

const nameTaken = (name) =>
  conflict(`A queue named "${name}" already exists`, 'QUEUE_NAME_TAKEN');

/** Loads a queue owned by the user. Missing and foreign queues both return 404. */
export const getOwnedQueue = async ({ userId, queueId }) => {
  const queue = await queueRepository.findForUser({ queueId, userId });
  if (!queue) {
    throw notFound('Queue');
  }
  return queue;
};

export const queueService = {
  async create({ userId, name, description, concurrency, defaultJobOptions }) {
    try {
      const queue = await queueRepository.create({
        userId,
        name,
        description: description ?? null,
        concurrency,
        defaultJobOptions: defaultJobOptions ?? {},
      });
      return serializeQueue(queue);
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw nameTaken(name);
      }
      throw err;
    }
  },

  async list({ userId, page, limit, status, search }) {
    const { rows, count } = await queueRepository.listForUser({
      userId,
      statuses: status,
      search,
      limit,
      offset: (page - 1) * limit,
    });
    return { data: rows.map(serializeQueue), meta: paginationMeta({ page, limit, total: count }) };
  },

  async get({ userId, queueId }) {
    return serializeQueue(await getOwnedQueue({ userId, queueId }));
  },

  /**
   * Applies changes under a row lock. When the status becomes ACTIVE (resume,
   * or un-archive), every WAITING job gets a fresh job.ready event in the same
   * transaction: entries delivered while the queue could not dispatch were
   * acknowledged without running, so nothing would wake those jobs otherwise.
   */
  async update({ userId, queueId, changes, guard }) {
    try {
      const queue = await getDatabase().transaction(async (transaction) => {
        const current = await queueRepository.findForUserLocked({ queueId, userId }, { transaction });
        if (!current) {
          throw notFound('Queue');
        }
        guard?.(current);
        const previousStatus = current.status;
        const updated = await queueRepository.update(current, changes, { transaction });
        if (updated.status === 'ACTIVE' && previousStatus !== 'ACTIVE') {
          await outboxRepository.createJobReadyForWaiting(updated.id, { transaction });
        }
        return updated;
      });
      return serializeQueue(queue);
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw nameTaken(changes.name);
      }
      throw err;
    }
  },

  /** Stops dispatching new jobs. Running jobs finish; submission still works. Idempotent. */
  pause({ userId, queueId }) {
    return this.update({
      userId,
      queueId,
      changes: { status: 'PAUSED' },
      guard: (queue) => {
        if (queue.status === 'ARCHIVED') {
          throw conflict('Archived queues cannot be paused', 'QUEUE_ARCHIVED');
        }
      },
    });
  },

  /** Resumes dispatch and re-announces waiting jobs. Idempotent. */
  resume({ userId, queueId }) {
    return this.update({
      userId,
      queueId,
      changes: { status: 'ACTIVE' },
      guard: (queue) => {
        if (queue.status === 'ARCHIVED') {
          throw conflict(
            'Archived queues cannot be resumed; set status ACTIVE with PATCH to un-archive',
            'QUEUE_ARCHIVED'
          );
        }
      },
    });
  },
};
